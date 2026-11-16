/**
 * Handle holds: a deleted account's handles cannot be taken while its
 * deletion is pending, or for 30 days after the hard delete. `handle_holds`
 * stores a keyed digest of each held handle, never the handle itself.
 *
 * The soft delete writes the digests; registration (`registerProfile`, the
 * sign-up probe, `checkHandle`), profile creation and organisation creation
 * read them through {@link heldHandleRow}, most through {@link handleArms},
 * and refuse a held handle with the answer they give a taken one.
 */

import { createHmac } from "node:crypto";

import { handleHolds, organisations, users } from "@osn/db/schema";
import type { DbService } from "@osn/db/service";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

/** Hashed in before the handle, so no other digest under the same key can equal one. */
const HANDLE_HOLD_LABEL = "osn-api handle hold\0";

/** The `handle_holds.handle` value for a handle. */
export type HeldHandleDigest = (handle: string) => string;

/**
 * The key every digest made with no pepper uses: random, made on first use
 * and kept for the life of the process or isolate. One key, not one per
 * service, because each route factory builds its own auth service, and a hold
 * written through one must be found through the others.
 */
let unpepperedKey: Uint8Array | undefined;

/**
 * Hex HMAC-SHA256 of the label and the handle, keyed by `pepper`
 * (`OSN_SESSION_IP_PEPPER`, required in every deployed tier). With no pepper
 * (local dev and tests), the key is {@link unpepperedKey}: holds then last as
 * long as the process does, never across a restart. A fixed key in the source
 * would let anyone who reads it test a handle against the table.
 *
 * Read by the auth service, which exposes it as `heldHandleDigest`, and through
 * it by the profile and organisation services and the soft delete.
 *
 * Rotating the pepper changes every digest, so every hold in the table stops
 * matching its handle: the handles become free before their holds end.
 */
export function makeHeldHandleDigest(pepper: string | undefined): HeldHandleDigest {
  const key = pepper ?? (unpepperedKey ??= crypto.getRandomValues(new Uint8Array(32)));
  return (handle) =>
    createHmac("sha256", key).update(HANDLE_HOLD_LABEL).update(handle).digest("hex");
}

/**
 * A select of `'handle'` from the live hold on `handle`: a row while the
 * deletion holding it is pending (`release_at` NULL) or before its release,
 * none from the second of the release on. `handle_holds.handle` is the primary
 * key, so at most one row.
 *
 * One column named `field`, so it joins a `unionAll` whose other arms select
 * the same, and reads alone or inside `exists()` as well.
 */
export const heldHandleRow = (
  db: DbService["db"],
  digest: HeldHandleDigest,
  handle: string,
  nowSec: number,
) =>
  db
    .select({ field: sql<string>`'handle'`.as("field") })
    .from(handleHolds)
    .where(
      and(
        eq(handleHolds.handle, digest(handle)),
        or(isNull(handleHolds.releaseAt), gt(handleHolds.releaseAt, nowSec)),
      ),
    );

/**
 * One `'handle'` row for each place `handle` is already spoken for: a
 * profile, an organisation (the two share one namespace), and a live hold
 * left by a deleted account. Separate single-table arms, each a seek on its
 * unique index, rather than an OR across a join, which SQLite plans as a
 * full scan, for one `unionAll` of three terms (D1 allows five). No per-arm
 * LIMIT: SQLite refuses LIMIT inside a compound select's arms, and each arm
 * yields at most one row anyway.
 */
export const handleArms = (
  db: DbService["db"],
  digest: HeldHandleDigest,
  handle: string,
  nowSec: number = Math.floor(Date.now() / 1000),
) =>
  [
    db
      .select({ field: sql<string>`'handle'`.as("field") })
      .from(users)
      .where(eq(users.handle, handle)),
    db
      .select({ field: sql<string>`'handle'`.as("field") })
      .from(organisations)
      .where(eq(organisations.handle, handle)),
    heldHandleRow(db, digest, handle, nowSec),
  ] as const;
