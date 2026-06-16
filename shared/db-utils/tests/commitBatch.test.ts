import { describe, expect, it, vi } from "vitest";

import { commitBatch } from "../src/index";

// `commitBatch` is the linchpin of the bun:sqlite→D1 migration: it feature-
// detects the driver and either issues one atomic `db.batch([...])` (D1) or
// awaits the statements sequentially in FK order (bun:sqlite). The per-app D1
// integration suites only ever hit the `.batch` branch, so these unit tests pin
// the other two branches (empty no-op + sequential fallback) directly.

type AnyDb = Parameters<typeof commitBatch>[0];

describe("commitBatch", () => {
  it("is a no-op for an empty statement set (never calls batch)", async () => {
    const batch = vi.fn();
    await commitBatch({ batch } as unknown as AnyDb, []);
    expect(batch).not.toHaveBeenCalled();
  });

  it("issues a single db.batch([...]) with all statements when batch exists (D1 path)", async () => {
    const batch = vi.fn().mockResolvedValue(undefined);
    const db = { batch } as unknown as AnyDb;
    const stmts = ["a", "b", "c"] as unknown as Parameters<typeof commitBatch>[1];

    await commitBatch(db, stmts);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(stmts);
  });

  it("awaits every statement in submitted order when batch is absent (bun:sqlite path)", async () => {
    const resolved: number[] = [];
    // Real promises (no hand-rolled thenable). `for … await` consumes them in
    // array order, so the recorded order pins the sequential fallback contract.
    const db = {} as AnyDb; // no `batch` method → sequential fallback
    const stmts = [1, 2, 3].map((n) =>
      Promise.resolve().then(() => {
        resolved.push(n);
      }),
    ) as unknown as Parameters<typeof commitBatch>[1];

    await commitBatch(db, stmts);

    expect(resolved).toEqual([1, 2, 3]);
  });
});
