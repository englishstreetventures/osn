import { rsvps, guests } from "@cire/db";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import { DbService, dbQuery, commitBatch } from "../db";
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
   * Upsert a batch of RSVPs (one per guest×event pair) in a SINGLE D1 round-trip
   * (P-W1). Caller MUST have validated every `guestId` belongs to the claimed
   * family AND every (guestId, eventId) is a real invitation before invoking —
   * this method does not re-check (the route validates the whole batch up front).
   *
   * Each pair becomes its own `INSERT … ON CONFLICT DO UPDATE`, collected into one
   * `db.batch([...])` via {@link commitBatch} — mirroring `applyImport`'s write set
   * and respecting the sync/async bridge:
   *  - D1 (production): one atomic Workers↔D1 round-trip for the whole batch
   *    (was N sequential round-trips on the guest hot path).
   *  - bun:sqlite (tests/local, no `.batch()`): `commitBatch` awaits the statements
   *    sequentially in-process — same per-pair upserts, no network cost.
   * Either way the per-pair upsert semantics + dietary-consent stamping are
   * unchanged. An empty batch is a no-op (no statements, no metrics). Per-pair
   * `metricRsvpUpserted` is preserved so the observability shape is identical to
   * N single submits. The whole batch shares one `now` (a single submit always
   * did too); a re-submit that clears dietary still nulls the consent record.
   */
  submitRsvps(inputs: readonly RsvpInput[]): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      if (inputs.length === 0) return;

      const now = new Date();
      const statements: BatchItem<"sqlite">[] = inputs.map((input) => {
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

      yield* dbQuery(() => commitBatch(db, statements));
      for (const input of inputs) {
        const writer = (input.consentSource ?? "guest") === "guest" ? "guest" : "organiser";
        yield* Effect.sync(() => metricRsvpUpserted(input.status, writer, "ok"));
      }
    }).pipe(Effect.withSpan("cire.rsvp.submit"));
  },

  getRsvpsForFamily(familyId: string): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = yield* dbQuery(() =>
        db
          .select({
            guestId: rsvps.guestId,
            eventId: rsvps.eventId,
            status: rsvps.status,
            dietary: rsvps.dietary,
          })
          .from(rsvps)
          .innerJoin(guests, eq(rsvps.guestId, guests.id))
          .where(eq(guests.familyId, familyId))
          .all(),
      );

      return rows;
    }).pipe(Effect.withSpan("cire.rsvp.list"));
  },
};
