import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, events, families, guests, imports } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import type { ParsedFamily } from "../schemas/import";
import { applyImport, diffAgainstDb } from "./import";
import { R2Service, createR2Stub, storeUpload } from "./r2-imports";
import { revertImport, NoPriorImport } from "./revert";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

const EVENTS_V1 = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_V1 = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony",
  "1,Sharma,Priya,Sharma,yes,yes",
].join("\n");

const EVENTS_V2 = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Wedding Ceremony,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
  "Reception,2026-09-20T19:00:00+10:00,2026-09-21T00:00:00+10:00,Australia/Sydney,Doltone,,,,,",
].join("\n");

const GUESTS_V2 = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Wedding Ceremony,Reception",
  "1,Sharma,Priya,Sharma,yes,yes,yes",
  "2,Wilson,James,Wilson,no,yes,yes",
].join("\n");

async function applyVersion(
  layer: Layer.Layer<DbService | R2Service>,
  importId: string,
  eventsCsv: string,
  guestsCsv: string,
  uploadedAt: number,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* storeUpload(eventsCsv, guestsCsv, importId);
      const ev = yield* parseEventsCsv(eventsCsv);
      const fam = (yield* parseGuestsCsv(guestsCsv, ev)) as ParsedFamily[];
      const plan = yield* diffAgainstDb(ev, fam);
      const summary = yield* applyImport(importId, plan);
      const db = yield* DbService;
      db.insert(imports)
        .values({
          id: importId,
          weddingId: BOOTSTRAP_WEDDING_ID,
          uploadedAt,
          format: "csv",
          eventsR2Key: `imports/${importId}/events.csv`,
          guestsR2Key: `imports/${importId}/guests.csv`,
          summary: JSON.stringify(summary),
          status: "applied",
          appliedAt: uploadedAt,
        })
        .run();
    }).pipe(Effect.provide(layer)),
  );
}

describe("revertImport", () => {
  it("reverts to the prior applied import's state", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyVersion(layer, "imp-1", EVENTS_V1, GUESTS_V1, 1_000);
    await applyVersion(layer, "imp-2", EVENTS_V2, GUESTS_V2, 2_000);

    expect(db.select().from(events).all()).toHaveLength(3);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);

    await Effect.runPromise(revertImport("imp-2").pipe(Effect.provide(layer)));

    // Back to v1 state: 2 events, 1 family, 1 guest.
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);

    const [imp2] = db.select().from(imports).where(eq(imports.id, "imp-2")).all();
    expect(imp2!.status).toBe("reverted");
    expect(imp2!.revertedAt).not.toBeNull();
  });

  it("fails with NoPriorImport when there's nothing earlier to roll back to", async () => {
    const db = createDb(":memory:");
    seedBootstrapWedding(db);
    const r2 = createR2Stub();
    const layer = Layer.merge(Layer.succeed(DbService, db), Layer.succeed(R2Service, r2));

    await applyVersion(layer, "imp-only", EVENTS_V1, GUESTS_V1, 1_000);

    const error = await Effect.runPromise(
      Effect.flip(revertImport("imp-only")).pipe(Effect.provide(layer)),
    );
    expect(error).toBeInstanceOf(NoPriorImport);
  });
});
