import type { DbService } from "@osn/db/service";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";

/** The D1 driver, which alone of the drivers here sends statements as one batch. */
export type BatchingDb = DbService["db"] & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
    statements: T,
  ): Promise<BatchResponse<T>>;
};

/**
 * True on the D1 driver, whose `batch` answers each statement's result in
 * order — a write's run result, for `rowsChanged`. bun:sqlite has no `batch`:
 * the caller awaits each statement in turn, and the statements of two requests
 * may then interleave, so a guard that must hold has to hold per statement.
 */
export const canBatch = (db: DbService["db"]): db is BatchingDb =>
  "batch" in db && typeof db.batch === "function";
