import { describe, expect, it } from "bun:test";

import { guests } from "@cire/db";
import { rowsChanged } from "@shared/db-utils";
import { eq } from "drizzle-orm";

import type { Db } from "../../src/db/index";
import {
  commitBatchResults,
  commitGroupedBatches,
  MAX_STATEMENTS_PER_BATCH,
} from "../../src/db/index";
import { createDb, seedDb } from "../../src/db/setup";

// commitGroupedBatches packs whole statement-groups into batches under D1's
// per-batch statement ceiling. These tests drive it with a fake batchable db
// that records batch sizes — the packing maths is driver-independent.

type Stmt = { n: number };

function fakeBatchDb(record: number[]): Db {
  return {
    batch: (statements: Stmt[]) => {
      record.push(statements.length);
      return Promise.resolve();
    },
  } as unknown as Db;
}

const group = (size: number): Stmt[] => Array.from({ length: size }, (_, n) => ({ n }));

describe("commitGroupedBatches", () => {
  it("commits everything in one batch when it fits", async () => {
    const sizes: number[] = [];
    await commitGroupedBatches(fakeBatchDb(sizes), [group(1), group(2), group(2)] as never);
    expect(sizes).toEqual([5]);
  });

  it("never splits a group across two batches", async () => {
    const sizes: number[] = [];
    // 1 + 24×2 = 49 fits; the 25th pair would make 51, so it opens batch two.
    const groups = [group(1), ...Array.from({ length: 30 }, () => group(2))];
    await commitGroupedBatches(fakeBatchDb(sizes), groups as never);
    expect(sizes).toEqual([49, 12]);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_STATEMENTS_PER_BATCH);
  });

  it("passes a single oversized group through as its own loud batch", async () => {
    const sizes: number[] = [];
    await commitGroupedBatches(fakeBatchDb(sizes), [group(MAX_STATEMENTS_PER_BATCH + 3)] as never);
    expect(sizes).toEqual([MAX_STATEMENTS_PER_BATCH + 3]);
  });

  it("is a no-op for zero groups", async () => {
    const sizes: number[] = [];
    await commitGroupedBatches(fakeBatchDb(sizes), []);
    expect(sizes).toEqual([]);
  });
});

describe("commitBatchResults", () => {
  it("hands every statement to ONE batch and returns its results in order", async () => {
    const seen: unknown[][] = [];
    const db = {
      batch: (statements: unknown[]) => {
        seen.push(statements);
        return Promise.resolve(statements.map((_, i) => `result ${i}`));
      },
    } as unknown as Db;
    const statements = group(3);
    expect(await commitBatchResults(db, statements as never)).toEqual([
      "result 0",
      "result 1",
      "result 2",
    ]);
    expect(seen).toEqual([statements]);
  });

  it("sends nothing for an empty list, which D1 would refuse", async () => {
    const seen: unknown[] = [];
    const db = {
      batch: (statements: unknown[]) => {
        seen.push(statements);
        return Promise.resolve([]);
      },
    } as unknown as Db;
    expect(await commitBatchResults(db, [])).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("on bun:sqlite, runs the statements in order and returns each one's result", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const [bo] = db.select({ id: guests.id }).from(guests).where(eq(guests.firstName, "Bo")).all();
    const results = await commitBatchResults(db, [
      db.update(guests).set({ nickname: "B" }).where(eq(guests.id, bo!.id)),
      // Runs after the update, so it reads the value the update wrote.
      db.select({ nickname: guests.nickname }).from(guests).where(eq(guests.id, bo!.id)),
    ]);
    expect(rowsChanged(results[0])).toBe(1);
    expect(results[1]).toEqual([{ nickname: "B" }]);
  });
});
