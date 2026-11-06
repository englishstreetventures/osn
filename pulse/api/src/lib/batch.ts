import type { DbService } from "@pulse/db/service";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";

/** The D1 driver, which alone of the drivers here sends statements as one batch. */
type BatchingDb = DbService["db"] & {
  batch<U extends BatchItem<"sqlite">, T extends Readonly<[U, ...U[]]>>(
    statements: T,
  ): Promise<BatchResponse<T>>;
};

/**
 * True on the D1 driver, whose `batch` sends its statements in one request,
 * commits them as one transaction and answers each statement's result in
 * order. bun:sqlite has no `batch`: the caller awaits each statement in turn,
 * so a guard that must hold has to hold per statement.
 */
export const canBatch = (db: DbService["db"]): db is BatchingDb =>
  "batch" in db && typeof db.batch === "function";
