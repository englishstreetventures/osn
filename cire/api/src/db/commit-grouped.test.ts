import { describe, expect, it } from "bun:test";

import type { Db } from "./index";
import { commitGroupedBatches, MAX_STATEMENTS_PER_BATCH } from "./index";

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
