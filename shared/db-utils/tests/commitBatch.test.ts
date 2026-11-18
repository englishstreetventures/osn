import { describe, expect, it, vi } from "vitest";

import { commitBatch } from "../src/index";

// `commitBatch` sends the statements as one `db.batch([...])` when the driver
// has one (D1), runs them one at a time in the order given when it does not
// (bun:sqlite), and does nothing for an empty list. The per-app D1 suites reach
// only the `batch` branch; the sequential fallback is held here alone.

type AnyDb = Parameters<typeof commitBatch>[0];
type Statements = Parameters<typeof commitBatch>[1];

/**
 * A statement that runs only when awaited, as a drizzle query builder does:
 * calling its `then` logs `start n`, and it settles one `setImmediate` turn
 * later, logging `end n`. bun:sqlite's builders finish inside `then`, so this
 * stands in for an async driver, where statements run together could land a
 * child row before its parent. A Proxy supplies `then` because an object
 * literal or class carrying one is the thenable lint forbids.
 */
function lazyStatement(n: number, log: string[]): object {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop !== "then") return undefined;
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
          log.push(`start ${n}`);
          return new Promise<void>((resolve) => {
            setImmediate(() => {
              log.push(`end ${n}`);
              resolve();
            });
          }).then(onFulfilled, onRejected);
        };
      },
    },
  );
}

describe("commitBatch", () => {
  it("is a no-op for an empty statement set (never calls batch)", async () => {
    const batch = vi.fn();
    await commitBatch({ batch } as unknown as AnyDb, []);
    expect(batch).not.toHaveBeenCalled();
  });

  it("issues a single db.batch([...]) with all statements when batch exists (D1 path)", async () => {
    const batch = vi.fn().mockResolvedValue(undefined);
    const db = { batch } as unknown as AnyDb;
    const stmts = ["a", "b", "c"] as unknown as Statements;

    await commitBatch(db, stmts);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledWith(stmts);
  });

  it("starts each statement only after the one before it has finished, and finishes all before returning (bun:sqlite path)", async () => {
    const log: string[] = [];
    const db = {} as AnyDb; // no `batch` method → sequential fallback
    const stmts = [1, 2, 3].map((n) => lazyStatement(n, log)) as unknown as Statements;

    await commitBatch(db, stmts);

    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });
});
