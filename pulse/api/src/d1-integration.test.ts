import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import type { D1Database as DrizzleD1 } from "@cloudflare/workers-types";
import * as schema from "@pulse/db/schema";
import { pulseAccountPurges, pulseDeletionJobs } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { createSchemaSql } from "@pulse/db/testing";
import { createD1Db } from "@shared/db-utils";
import { Effect, Layer } from "effect";
import { Miniflare } from "miniflare";

import {
  cancelErasure,
  getDeletionStatus,
  purgeAccount,
  requestErasure,
} from "./services/accountErasure";

// Integration tests against a REAL (workerd-backed) D1 database via Miniflare.
// These exercise the ASYNCHRONOUS D1 driver path the `dev`/`staging`/`prod`
// environments use — specifically the `commitBatch` → `db.batch([...])` branch
// of the account-erasure flows, which bun:sqlite (the unit suite) never reaches.

/* eslint-disable no-await-in-loop */

let mf: Miniflare;
let layer: Layer.Layer<Db>;
let rawDb: ReturnType<typeof createD1Db<typeof schema>>;

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
  rawDb = createD1Db(d1, schema);
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

  it("cancelErasure clears the job via the async batch path", async () => {
    await run(requestErasure({ profileId: "usr_p2", accountId: "acc_2" }));
    const cancelled = await run(cancelErasure("usr_p2"));
    expect(cancelled.cancelled).toBe(true);

    const status = await run(getDeletionStatus("usr_p2"));
    expect(status.scheduled).toBe(false);
  });

  it("purgeAccount is idempotent via the replay ledger (batch insert on D1)", async () => {
    const first = await run(purgeAccount("acc_3", ["usr_p3"]));
    expect(first).toMatchObject({ purged: 1, alreadyProcessed: false });

    // Second call finds the ledger row written by the first batch → no-op.
    const second = await run(purgeAccount("acc_3", ["usr_p3"]));
    expect(second).toMatchObject({ purged: 0, alreadyProcessed: true });
  });
});
