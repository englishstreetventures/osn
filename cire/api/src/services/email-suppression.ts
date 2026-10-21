import { emailSuppressions, families, guests } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { bound, type Db, DbService, dbQuery, outerColumn } from "../db";

// The suppression list: addresses a wedding must not email
// (`email_suppressions`, [[wiki/compliance/data-map]]).
//
// A row holds a hash, never an address, and names the seat that withdrew the
// address. An address is suppressed for the wedding when any row matches its
// hash, so one seat's objection stops mail to every seat holding it; only the
// seat that made a row clears it, by giving the address again. Every read here
// is bounded by the addresses it asks about, never by how many rows the list
// holds. Guest comms check an address with `suppressedAmong` before sending.

const ENCODER = new TextEncoder();

/**
 * The SHA-256, in lower-case hex, of `weddingId + ":" + address`, where
 * `address` is the stored (normalised) form. Keyed by the wedding so one
 * person's rows in two weddings do not share a value without a candidate
 * address to test. Not a secret: anyone holding a candidate address can test
 * it, so it is pseudonymous personal data — and a DSAR finds a guest's rows by
 * hashing their address the same way. Written to `guests.email_hash` with the
 * address, so reads never hash.
 */
export async function hashGuestEmail(weddingId: string, address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(`${weddingId}:${address}`));
  // Built from the bytes: Workers' `Buffer` type has no hex `toString`.
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Record that `guestId` withdrew the address its row holds now, in the batch
 * that clears it: the hash is read from `guests.email_hash` by the statement
 * itself, so the opt-out names whatever address the row held when the batch
 * ran, never one read earlier. Writes nothing for a row with no address, and a
 * second identical opt-out is a no-op.
 */
export function suppressCurrentStatement(
  db: Db,
  row: { weddingId: string; guestId: string; now: Date },
): BatchItem<"sqlite"> {
  return db
    .insert(emailSuppressions)
    .select(
      // Every `email_suppressions` column, in the table's order.
      db
        .select({
          id: bound(crypto.randomUUID(), emailSuppressions.id),
          weddingId: bound(row.weddingId, emailSuppressions.weddingId),
          emailHash: sql`${guests.emailHash}`.as("email_hash"),
          guestId: sql`${guests.id}`.as("guest_id"),
          reason: bound("guest_removed", emailSuppressions.reason),
          createdAt: bound(row.now, emailSuppressions.createdAt),
        })
        .from(guests)
        .where(and(eq(guests.id, row.guestId), isNotNull(guests.emailHash))),
    )
    .onConflictDoNothing();
}

/** Clear the opt-out `guestId` itself made for this address, and no other. */
export function unsuppressOwnStatement(
  db: Db,
  row: { weddingId: string; emailHash: string; guestId: string },
): BatchItem<"sqlite"> {
  return db
    .delete(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.weddingId, row.weddingId),
        eq(emailSuppressions.emailHash, row.emailHash),
        eq(emailSuppressions.guestId, row.guestId),
      ),
    );
}

/**
 * Which of `hashes` the wedding has suppressed. One read, bounded by the
 * hashes asked about (they ride as one bound parameter), none for an empty
 * list.
 */
export function suppressedAmong(
  weddingId: string,
  hashes: readonly string[],
): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    if (hashes.length === 0) return new Set<string>();
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .selectDistinct({ hash: emailSuppressions.emailHash })
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.weddingId, weddingId),
            inArray(emailSuppressions.emailHash, jsonEachIn([...new Set(hashes)])),
          ),
        )
        .all(),
    );
    return new Set(rows.map((r) => r.hash));
  }).pipe(Effect.withSpan("cire.suppression.read"));
}

/**
 * The wedding's guests whose stored address the wedding has suppressed. One
 * read, bounded by the wedding's guests (the tier's guest cap): each guest
 * with an address probes the list's `(wedding_id, email_hash)` index once.
 */
export function optedOutGuests(weddingId: string): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ id: guests.id })
        .from(guests)
        .innerJoin(families, eq(guests.familyId, families.id))
        .where(
          and(
            eq(families.weddingId, weddingId),
            isNotNull(guests.emailHash),
            sql`exists (select 1 from ${emailSuppressions} where ${emailSuppressions.weddingId} = ${outerColumn(families.weddingId)} and ${emailSuppressions.emailHash} = ${outerColumn(guests.emailHash)})`,
          ),
        )
        .all(),
    );
    return new Set(rows.map((r) => r.id));
  }).pipe(Effect.withSpan("cire.suppression.read"));
}
