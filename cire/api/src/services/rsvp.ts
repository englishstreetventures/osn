import { rsvps, guests } from "@cire/db";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import type { Db, ReturningTail } from "../db";
import { DbService, dbQuery, commitGroupedBatches, commitGroupedBatchesReturning } from "../db";
import { metricRsvpUpserted } from "../metrics";
import { DIETARY_CONSENT_VERSION } from "../schemas/rsvp";
import type { RsvpRecord } from "../schemas/rsvp";

/** RSVP consent provenance = who recorded the row AND on whose consent
 *  authority the dietary free-text is held (migration 0037). `guest` — the
 *  guest self-submitted and gave their own Art. 9(2)(a) consent.
 *  `organiser_attested` — an organiser recorded a phone/paper RSVP and attests
 *  the guest consented. Defaults to `guest` for the invite write path. */
export type ConsentSource = "guest" | "organiser_attested";

/** One guest×event RSVP to upsert. */
export interface RsvpInput {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  // True only when consent is present AND there is dietary text to authorise
  // (the route already collapses both conditions). Stamps an Art. 9(2)(a)
  // consent record; false clears any prior record (e.g. dietary removed).
  dietaryConsent: boolean;
  // Who recorded the row + the consent basis. Optional; defaults to `guest`
  // (the invite write path). The organiser endpoint passes `organiser_attested`
  // so the row is distinguishable and its dietary consent is attested, not
  // self-given. Stamped into `rsvps.consent_source`.
  consentSource?: ConsentSource;
}

/**
 * Build one `INSERT … ON CONFLICT DO UPDATE` per input. The single place that
 * knows the upsert shape — {@link rsvpService.submitRsvps} and
 * {@link rsvpService.submitRsvpsAndList} both call this instead of building
 * their own, so the two paths cannot drift apart.
 */
function buildRsvpUpsertStatements(
  db: Db,
  inputs: readonly RsvpInput[],
  now: Date,
): BatchItem<"sqlite">[] {
  return inputs.map((input) => {
    const dietaryConsentAt = input.dietaryConsent ? now : null;
    const dietaryConsentVersion = input.dietaryConsent ? DIETARY_CONSENT_VERSION : null;
    const consentSource: ConsentSource = input.consentSource ?? "guest";
    return db
      .insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: input.guestId,
        eventId: input.eventId,
        status: input.status,
        dietary: input.dietary,
        dietaryConsentAt,
        dietaryConsentVersion,
        consentSource,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [rsvps.guestId, rsvps.eventId],
        set: {
          status: input.status,
          dietary: input.dietary,
          dietaryConsentAt,
          dietaryConsentVersion,
          // Overwrite the writer/consent provenance too: an organiser
          // recording over a guest's reply (or vice-versa) must repoint
          // this so the row reflects who last wrote it.
          consentSource,
        },
      });
  });
}

/**
 * Build the read-back select for a family's RSVPs. The single place that
 * knows the read-back shape — {@link rsvpService.getRsvpsForFamily} and
 * {@link rsvpService.submitRsvpsAndList} both call this instead of building
 * their own. Deliberately unexecuted (no `.all()`): it must ride either as a
 * `db.batch()` array element (S1: keyed only on `familyId`) or, directly
 * awaited, resolve to the same rows on bun:sqlite.
 */
function buildFamilyRsvpsQuery(db: Db, familyId: string) {
  return db
    .select({
      guestId: rsvps.guestId,
      eventId: rsvps.eventId,
      status: rsvps.status,
      dietary: rsvps.dietary,
    })
    .from(rsvps)
    .innerJoin(guests, eq(rsvps.guestId, guests.id))
    .where(eq(guests.familyId, familyId));
}

export const rsvpService = {
  /**
   * Upsert one RSVP. Caller MUST validate `guestId` belongs to the claimed
   * family before invoking — this method does not re-check ownership. The
   * route handler builds the family-guest set once and validates the whole
   * batch up front, so a per-call SELECT here would be redundant.
   *
   * Thin wrapper over {@link submitRsvps} (a single-element batch) so the
   * one-pair and bulk paths share one implementation and stay semantically
   * identical.
   */
  submitRsvp(input: RsvpInput): Effect.Effect<void, never, DbService> {
    return rsvpService.submitRsvps([input]);
  },

  /**
   * Upsert a batch of RSVPs (one per guest×event pair) in as few D1 round-trips
   * as the ceiling allows (P-W1, chunked per P-W2). Caller MUST have validated
   * every `guestId` belongs to the claimed family AND every (guestId, eventId)
   * is a real invitation before invoking — this method does not re-check (the
   * route validates the whole batch up front).
   *
   * Each pair becomes its own `INSERT … ON CONFLICT DO UPDATE`, passed to
   * {@link commitGroupedBatches} as a singleton group per statement — mirroring
   * `applyImport`'s write set and respecting the sync/async bridge:
   *  - D1 (production): chunked into batches of at most `MAX_STATEMENTS_PER_BATCH`
   *    (was N sequential round-trips pre-P-W1, then one over-ceiling batch that
   *    could 500 above 50 statements pre-P-W2).
   *  - bun:sqlite (tests/local, no `.batch()`): statements run sequentially
   *    in-process — same per-pair upserts, no network cost.
   * Either way the per-pair upsert semantics + dietary-consent stamping are
   * unchanged. An empty batch is a no-op (no statements, no metrics). Per-pair
   * `metricRsvpUpserted` is preserved so the observability shape is identical to
   * N single submits. The whole batch shares one `now` (a single submit always
   * did too, and it's captured before chunking so every chunk stamps the same
   * `createdAt` / dietary-consent evidence); a re-submit that clears dietary
   * still nulls the consent record. Whole-set atomicity is deliberately given
   * up beyond `MAX_STATEMENTS_PER_BATCH` (each pair is an idempotent upsert on
   * `(guestId, eventId)`, safe to re-apply on retry).
   */
  submitRsvps(inputs: readonly RsvpInput[]): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (inputs.length === 0) return;

      const now = new Date();
      const statements = buildRsvpUpsertStatements(db, inputs, now);

      yield* dbQuery(() =>
        commitGroupedBatches(
          db,
          statements.map((s) => [s]),
        ),
      );
      for (const input of inputs) {
        const writer = (input.consentSource ?? "guest") === "guest" ? "guest" : "organiser";
        yield* Effect.sync(() => metricRsvpUpserted(input.status, writer, "ok"));
      }
    }).pipe(Effect.withSpan("cire.rsvp.submit"));
  },

  getRsvpsForFamily(familyId: string): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = yield* dbQuery(() => buildFamilyRsvpsQuery(db, familyId).all());

      return rows;
    }).pipe(Effect.withSpan("cire.rsvp.list"));
  },

  /**
   * {@link submitRsvps} and {@link getRsvpsForFamily} folded into one commit
   * (P-W1): the read-back rides as the trailing statement in the same
   * `db.batch()` array as the upserts instead of a second round-trip after
   * it. Same ownership precondition as `submitRsvps` — the caller must have
   * already validated every `guestId` belongs to `familyId` and every
   * (guestId, eventId) is a real invitation. S1: the read-back is keyed only
   * on the authenticated `familyId` passed in, never on anything in `inputs`.
   *
   * Same `now`/chunking/atomicity trade as `submitRsvps` — see its doc
   * comment. An empty `inputs` list still runs the read-back and returns
   * the family's current rows (an empty upsert set is a legal chunk).
   */
  submitRsvpsAndList(
    inputs: readonly RsvpInput[],
    familyId: string,
  ): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const now = new Date();
      const statements = buildRsvpUpsertStatements(db, inputs, now);
      const tail = buildFamilyRsvpsQuery(db, familyId) as ReturningTail<RsvpRecord>;

      const rows = yield* dbQuery(() =>
        commitGroupedBatchesReturning<RsvpRecord>(
          db,
          statements.map((s) => [s]),
          tail,
        ),
      );

      for (const input of inputs) {
        const writer = (input.consentSource ?? "guest") === "guest" ? "guest" : "organiser";
        yield* Effect.sync(() => metricRsvpUpserted(input.status, writer, "ok"));
      }

      return rows;
    }).pipe(Effect.withSpan("cire.rsvp.submitAndList"));
  },
};
