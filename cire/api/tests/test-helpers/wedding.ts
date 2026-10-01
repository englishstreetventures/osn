import { weddingHosts, weddings } from "@cire/db";

import type { Db } from "../../src/db";

type WeddingValues = typeof weddings.$inferInsert;
type SeatValues = typeof weddingHosts.$inferInsert;

/** A wedding row for {@link insertWedding}: its columns, with the timestamps
 *  defaulting to now, plus the profiles that own it. */
export type WeddingFixture = Omit<WeddingValues, "createdAt" | "updatedAt"> & {
  createdAt?: Date;
  updatedAt?: Date;
  /** Profiles given an `owner` seat, in order. Ownership is a seat, not a
   *  column, so a wedding inserted without owners has none. */
  owners?: readonly string[];
};

/**
 * The `wedding_hosts` row that makes `osnProfileId` an owner of `weddingId`,
 * attributed to themselves the way a wedding's creator's seat is. For a fixture
 * that inserts its own rows (an async D1 handle, a batch) rather than going
 * through {@link insertWedding}.
 */
export function ownerSeat(
  weddingId: string,
  osnProfileId: string,
  createdAt: Date = new Date(),
): SeatValues {
  return {
    id: `whost_${crypto.randomUUID()}`,
    weddingId,
    osnProfileId,
    addedByOsnProfileId: osnProfileId,
    role: "owner",
    createdAt,
  };
}

/**
 * Insert a wedding row and an `owner` seat for each of `owners`. For the
 * in-memory bun:sqlite database (`createDb`), whose writes run synchronously;
 * a D1 handle's writes would need awaiting, so D1 fixtures insert their own
 * rows with {@link ownerSeat}.
 */
export function insertWedding(db: Db, fixture: WeddingFixture): void {
  const { owners = [], createdAt = new Date(), updatedAt = createdAt, ...row } = fixture;
  db.insert(weddings)
    .values({ ...row, createdAt, updatedAt })
    .run();
  for (const owner of owners) {
    db.insert(weddingHosts)
      .values(ownerSeat(row.id, owner, createdAt))
      .run();
  }
}
