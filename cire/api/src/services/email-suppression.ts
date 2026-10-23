import { emailSuppressions, guests } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { and, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { bound, type Db, DbService, dbQuery } from "../db";

// The suppression list: addresses a wedding must not email
// (`email_suppressions`, [[wiki/compliance/data-map]]).
//
// A row holds a hash, never an address, and names the seat that withdrew an
// address the hosts added: by removing it, or by replacing it with another. An
// address the guest gave themselves writes no row when it goes: anyone holding
// the household code can type any address on a seat, so its removal says
// nothing about whose mailbox it is. An address is suppressed for the wedding
// when any row matches its hash, so one seat's objection stops mail to every
// seat holding it; only the seat that made a row clears it, by giving the
// address again. Every read here is bounded by the addresses it asks about,
// never by how many rows the list holds. Guest comms check an address with
// `suppressedAmong` before sending.

const ENCODER = new TextEncoder();

/** The SHA-256 of `text`'s UTF-8 bytes, in lower-case hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(text));
  // Built from the bytes: Workers' `Buffer` type has no hex `toString`.
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The SHA-256, in lower-case hex, of `weddingId + ":" + address`, where
 * `address` is the stored (normalised) form. Keyed by the wedding so one
 * person's rows in two weddings do not share a value without a candidate
 * address to test. Not a secret: anyone holding a candidate address can test
 * it, so it is pseudonymous personal data — and a DSAR finds a guest's rows by
 * hashing their address the same way. Written to `guests.email_hash` with the
 * address, so reads never hash.
 */
export function hashGuestEmail(weddingId: string, address: string): Promise<string> {
  return sha256Hex(`${weddingId}:${address}`);
}

/**
 * An opt-out for `guestId` taken from the address its row holds when the batch
 * runs: the hash is read from `guests.email_hash` by the statement itself, so
 * it names whatever address the row held then, never one read earlier. Writes
 * nothing for a row with no address or one `only` excludes, and a second
 * opt-out for the same seat and address is a no-op.
 */
function suppressHeldStatement(
  db: Db,
  row: { weddingId: string; guestId: string; now: Date },
  reason: "guest_removed" | "guest_corrected",
  only?: SQL,
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
          reason: bound(reason, emailSuppressions.reason),
          createdAt: bound(row.now, emailSuppressions.createdAt),
        })
        .from(guests)
        .where(and(eq(guests.id, row.guestId), isNotNull(guests.emailHash), only)),
    )
    .onConflictDoNothing();
}

/**
 * Record that `guestId` withdrew the address its row holds now, in the batch
 * that clears it (`reason = 'guest_removed'`), when the hosts added that
 * address: the guest's word against the hosts' attestation stands for the
 * wedding. Writes nothing for an address the guest gave themselves. Who added
 * it is read from the row when the batch runs, by its source, which stays
 * `organiser_attested` when the attesting organiser's id has gone.
 */
export function suppressCurrentStatement(
  db: Db,
  row: { weddingId: string; guestId: string; now: Date },
): BatchItem<"sqlite"> {
  return suppressHeldStatement(
    db,
    row,
    "guest_removed",
    eq(guests.emailSource, "organiser_attested"),
  );
}

/**
 * Record that `guestId` corrected away the address its row holds now, in the
 * batch that replaces it, when the hosts added that address and it is not the
 * one replacing it (`reason = 'guest_corrected'`): the guest has said it is
 * wrong, so a later sheet or revert that puts it back is warned about or
 * skipped like a removal. A guest replacing their own address records nothing.
 */
export function suppressReplacedStatement(
  db: Db,
  row: { weddingId: string; guestId: string; replacementHash: string; now: Date },
): BatchItem<"sqlite"> {
  return suppressHeldStatement(
    db,
    row,
    "guest_corrected",
    and(eq(guests.emailSource, "organiser_attested"), ne(guests.emailHash, row.replacementHash)),
  );
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
 * Whether `guestId` itself holds an opt-out for this address. One read of at
 * most one row.
 */
export function holdsOwnOptOut(row: {
  weddingId: string;
  emailHash: string;
  guestId: string;
}): Effect.Effect<boolean, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ one: sql<number>`1` })
        .from(emailSuppressions)
        .where(
          and(
            eq(emailSuppressions.weddingId, row.weddingId),
            eq(emailSuppressions.emailHash, row.emailHash),
            eq(emailSuppressions.guestId, row.guestId),
          ),
        )
        .limit(1)
        .all(),
    );
    return rows.length > 0;
  }).pipe(Effect.withSpan("cire.suppression.read"));
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
