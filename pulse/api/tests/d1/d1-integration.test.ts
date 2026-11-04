import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import { events, eventSeries, pulseAccountPurges, pulseDeletionJobs } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { createSchemaSql } from "@pulse/db/testing";
import { createD1Db, insertManyViaJsonEach } from "@shared/db-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import {
  cancelErasure,
  getDeletionStatus,
  purgeAccount,
  requestErasure,
} from "../../src/services/accountErasure";
import { cancelSeries, createSeries } from "../../src/services/series";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// These exercise the ASYNCHRONOUS D1 driver path the `dev`/`staging`/`prod`
// environments use — specifically the `commitBatch` → `db.batch([...])` branch
// of the account-erasure flows, which bun:sqlite (the unit suite) never reaches.

/* eslint-disable no-await-in-loop */

let mf: Miniflare;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db>;

const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(layer)));

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
  });
  const d1 = (await mf.getD1Database("DB")) as unknown as DrizzleD1;
  for (const stmt of createSchemaSql()) {
    await d1.prepare(stmt).run();
  }
  rawDb = createD1Db(d1);
  layer = Layer.succeed(Db, { db: rawDb });
});

afterAll(async () => {
  await mf?.dispose();
});

beforeEach(async () => {
  await rawDb.delete(pulseDeletionJobs);
  await rawDb.delete(pulseAccountPurges);
});

describe("pulse/api account erasure over real D1 (Miniflare)", () => {
  it("requestErasure commits a batch and getDeletionStatus reads it back", async () => {
    const out = await run(
      requestErasure({ profileId: "usr_p1", accountId: "acc_1", reason: "user_request" }),
    );
    expect(out.newlyScheduled).toBe(true);

    const status = await run(getDeletionStatus("usr_p1"));
    expect(status.scheduled).toBe(true);
  });

  // Both erasure batches run over hosted rows here: on D1 the statements of a
  // batch run in order inside one transaction, which is what `requestErasure`'s
  // second events UPDATE and `cancelErasure`'s CASE update rely on.
  it("cancelErasure clears the job via the async batch path", async () => {
    const now = new Date();
    const hosted = (id: string) => ({
      id,
      title: id,
      startTime: new Date(now.getTime() + 86_400_000),
      status: "upcoming" as const,
      visibility: "public" as const,
      guestListVisibility: "public" as const,
      joinPolicy: "open" as const,
      allowInterested: true,
      commsChannels: '["email"]',
      instanceOverride: false,
      createdByProfileId: "usr_p2",
      createdByName: "Leaving Host",
      createdAt: now,
      updatedAt: now,
    });
    await rawDb.insert(events).values(hosted("evt_p2_live"));
    await rawDb.insert(events).values({
      ...hosted("evt_p2_called_off"),
      status: "cancelled",
      cancelledAt: 1_000,
      cancellationReason: "organiser",
    });
    const read = async (id: string) =>
      (await rawDb.select().from(events).where(eq(events.id, id)).all())[0]!;

    await run(requestErasure({ profileId: "usr_p2", accountId: "acc_2" }));
    const left = await read("evt_p2_live");
    expect(left.status).toBe("cancelled");
    expect(left.cancellationReason).toBe("host_left");
    expect(left.hardDeleteAt).toBeGreaterThan(0);
    const calledOff = await read("evt_p2_called_off");
    expect(calledOff.hardDeleteAt).toBe(left.hardDeleteAt);
    expect(calledOff.cancellationReason).toBe("organiser");

    const cancelled = await run(cancelErasure("usr_p2"));
    expect(cancelled.cancelled).toBe(true);

    const status = await run(getDeletionStatus("usr_p2"));
    expect(status.scheduled).toBe(false);

    const restored = await read("evt_p2_live");
    expect(restored.status).toBe("upcoming");
    expect(restored.cancelledAt).toBeNull();
    expect(restored.cancellationReason).toBeNull();
    expect(restored.hardDeleteAt).toBeNull();
    const kept = await read("evt_p2_called_off");
    expect(kept.status).toBe("cancelled");
    expect(kept.cancelledAt).toBe(1_000);
    expect(kept.cancellationReason).toBe("organiser");
    expect(kept.hardDeleteAt).toBeNull();
  });

  // `hostedEventIds` is read unbounded, then bound into four DELETEs inside
  // one atomic commitBatch via `jsonEachIn` — a single JSON parameter per
  // statement rather than one per id, so an account that hosted more than
  // ~100 events stays under D1's 100-bound-parameter cap. The deletes are
  // deliberately one batch, so a failing statement rolls every statement
  // back: a purge cannot partially complete, which makes the cap the
  // difference between completing and never completing for exactly the
  // accounts with the most data to erase.
  //
  // This has to run against real D1; bun:sqlite enforces no bind cap, so the
  // unit tier passes against the bug.
  it("purges an account that hosted more than 100 events", async () => {
    const now = new Date();
    const hosted = Array.from({ length: 150 }, (_, i) => ({
      id: `evt_bulk_${i}`,
      title: `Event ${i}`,
      startTime: now,
      status: "upcoming" as const,
      visibility: "public" as const,
      guestListVisibility: "public" as const,
      joinPolicy: "open" as const,
      allowInterested: true,
      commsChannels: '["email"]',
      instanceOverride: false,
      createdByProfileId: "usr_bulk",
      createdByName: "Bulk Host",
      createdAt: now,
      updatedAt: now,
    }));
    // Seeded through the helper this batch introduces, not `.values(rows)`.
    // A 150-row `.values()` insert is itself over D1's bind cap — the first
    // draft of this test hit `too many SQL variables` while setting up the
    // fixture for a bug about `too many SQL variables`. That the seeding works
    // at all is a second, incidental proof the helper does what it claims on
    // real D1.
    await rawDb.run(insertManyViaJsonEach(events, hosted));

    const out = await run(purgeAccount("acc_bulk", ["usr_bulk"]));
    expect(out).toMatchObject({ purged: 1, alreadyProcessed: false });

    // The whole point: the events are gone, which means the batch committed
    // rather than rolling back on a bind-cap error.
    const left = await rawDb.select({ id: events.id }).from(events).all();
    expect(left.filter((e) => e.id.startsWith("evt_bulk_"))).toHaveLength(0);
  });

  it("purgeAccount is idempotent via the replay ledger (batch insert on D1)", async () => {
    const first = await run(purgeAccount("acc_3", ["usr_p3"]));
    expect(first).toMatchObject({ purged: 1, alreadyProcessed: false });

    // Second call finds the ledger row written by the first batch → no-op.
    const second = await run(purgeAccount("acc_3", ["usr_p3"]));
    expect(second).toMatchObject({ purged: 0, alreadyProcessed: true });
  });
});

describe("pulse/api series cancel over real D1 (Miniflare)", () => {
  // The instances and the series are cancelled in one batch: one request, one
  // transaction, and the count comes from the first statement's RETURNING.
  it("cancelSeries sends one batch and counts the instances it cancelled", async () => {
    const { series } = await run(
      createSeries(
        {
          title: "Weekly on D1",
          rrule: "FREQ=WEEKLY;COUNT=3",
          dtstart: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
        { createdByProfileId: "usr_series", createdByName: "Series Host", createdByAvatar: null },
      ),
    );
    const batch = spyOn(rawDb as unknown as { batch: (...a: unknown[]) => unknown }, "batch");
    try {
      const first = await run(cancelSeries(series.id, "usr_series"));
      expect(first.cancelled).toBe(3);
      expect(batch).toHaveBeenCalledTimes(1);
    } finally {
      batch.mockRestore();
    }
    const instances = await rawDb.select().from(events).where(eq(events.seriesId, series.id)).all();
    expect(instances.map((r) => [r.status, r.cancellationReason])).toEqual([
      ["cancelled", "organiser"],
      ["cancelled", "organiser"],
      ["cancelled", "organiser"],
    ]);
    const [closed] = await rawDb
      .select()
      .from(eventSeries)
      .where(eq(eventSeries.id, series.id))
      .all();
    expect(closed!.status).toBe("cancelled");
    expect((await run(cancelSeries(series.id, "usr_series"))).cancelled).toBe(0);
  });
});
