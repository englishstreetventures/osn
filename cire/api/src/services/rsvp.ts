import { rsvps, guests } from "@cire/db";
import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
  parsePresets,
  PLUS_ONE_DIETARY_ATTESTATION,
  serialisePresets,
  type DietaryPreset,
} from "@cire/dietary";
import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Effect } from "effect";

import type { Db, ReturningTail } from "../db";
import { DbService, dbQuery, commitGroupedBatches, commitGroupedBatchesReturning } from "../db";
import { metricRsvpUpserted } from "../metrics";
import type { RsvpWriter } from "../metrics";
import { DIETARY_CONSENT_VERSION } from "../schemas/rsvp";
import type { RsvpRecord } from "../schemas/rsvp";
import { buildRecordStatement, type RsvpChangeInput } from "./rsvp-changes";

/** RSVP consent provenance = who recorded the row AND on whose consent
 *  authority the dietary free-text is held (migration 0037). `guest` — the
 *  guest self-submitted and gave their own Art. 9(2)(a) consent.
 *  `organiser_attested` — an organiser recorded a phone/paper RSVP and attests
 *  the guest consented. `inviter_attested` — the household recorded the reply
 *  of the plus-one it brought (migration 0066). Defaults to `guest` for the
 *  invite write path. Read off the column, so the enum has one home. */
export type ConsentSource = (typeof rsvps.$inferSelect)["consentSource"];

/**
 * The consent version a reply is stamped with, chosen by who recorded it and,
 * for an organiser, whom it is about: each writer ticks its own words, and the
 * row names the version of those words — the guest's own-consent copy, the
 * household's attestation for its plus-one, or the organiser's attestation for
 * a phone or paper reply, which speaks of the guest or, on a plus-one's reply,
 * of the plus-one. The one place a version is chosen.
 */
export function dietaryConsentVersionFor(source: ConsentSource, isPlusOne = false): string {
  switch (source) {
    case "inviter_attested":
      return PLUS_ONE_DIETARY_ATTESTATION.version;
    case "organiser_attested":
      return isPlusOne
        ? ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version
        : ORGANISER_DIETARY_ATTESTATION.version;
    case "guest":
      return DIETARY_CONSENT_VERSION;
  }
}

/**
 * Whether a stored consent record may open the invite's box for this person
 * already ticked: it must have been made by the writer that box speaks for,
 * against the words the box shows now. A member's box is their own consent
 * (`guest`, the own-consent version); a plus-one's is the household's
 * attestation (`inviter_attested`, the attestation version). A record anyone
 * else made — an organiser's phone reply — never pre-ticks either box: a
 * pre-ticked box is not consent (Art. 4(11)), and the person ticking it did not
 * make that record. The claim payload and the RSVP read-back both answer
 * through this, so the two cannot disagree.
 */
export function isDietaryConsentCurrent(row: {
  version: string | null;
  source: ConsentSource;
  isPlusOne: boolean;
}): boolean {
  if (row.isPlusOne) {
    return (
      row.source === "inviter_attested" && row.version === PLUS_ONE_DIETARY_ATTESTATION.version
    );
  }
  return row.source === "guest" && row.version === DIETARY_CONSENT_VERSION;
}

/** Which writer class a provenance value belongs to, for the upsert counter:
 *  only an organiser's attestation is an organiser write. */
function writerOf(source: ConsentSource): RsvpWriter {
  return source === "organiser_attested" ? "organiser" : "guest";
}

/** One guest×event RSVP to upsert. */
export interface RsvpInput {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  // The guest's picks from the closed vocabulary. Stored canonically ordered and
  // deduplicated by `serialisePresets`, so one selection has one stored string.
  dietaryPresets: readonly DietaryPreset[];
  // True only when consent is present AND there is dietary data to authorise —
  // presets or free text, since both are special-category (the route already
  // collapses those conditions). Stamps an Art. 9(2)(a) consent record; false
  // clears any prior record (e.g. the guest cleared their whole answer).
  dietaryConsent: boolean;
  // Who recorded the row + the consent basis. Optional; defaults to `guest`
  // (the invite write path). The organiser endpoint passes `organiser_attested`
  // so the row is distinguishable and its dietary consent is attested, not
  // self-given; the invite passes `inviter_attested` for a plus-one's reply.
  // Stamped into `rsvps.consent_source`.
  consentSource?: ConsentSource;
  // Whether the reply is a plus-one's. Read only to choose an organiser's
  // attestation version (`dietaryConsentVersionFor`): the organiser ticks other
  // words for a plus-one than for a guest. Optional; defaults to false.
  plusOne?: boolean;
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
    const consentSource: ConsentSource = input.consentSource ?? "guest";
    const dietaryConsentAt = input.dietaryConsent ? now : null;
    const dietaryConsentVersion = input.dietaryConsent
      ? dietaryConsentVersionFor(consentSource, input.plusOne ?? false)
      : null;
    // Serialised once: the insert and the conflict-update store the same value.
    const dietaryPresets = serialisePresets(input.dietaryPresets);
    return db
      .insert(rsvps)
      .values({
        id: crypto.randomUUID(),
        guestId: input.guestId,
        eventId: input.eventId,
        status: input.status,
        dietary: input.dietary,
        dietaryPresets,
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
          dietaryPresets,
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
 * The stored row, before {@link toRsvpRecord} widens it.
 *
 * `dietary_presets` is one comma-separated string in the column and an array in
 * every consumer, so the two shapes need separate names — the read-back rides as
 * the trailing statement of a `db.batch()` and is cast to its row type, and a
 * cast straight to {@link RsvpRecord} would quietly claim the parse had already
 * happened.
 */
type RsvpRow = Omit<RsvpRecord, "dietaryPresets" | "dietaryConsentCurrent"> & {
  dietaryPresets: string;
  dietaryConsentVersion: string | null;
  consentSource: ConsentSource;
  plusOneOf: string | null;
};

/** The stored row as the invite reads it. The consent version, its writer and
 *  the plus-one link are read only to answer `dietaryConsentCurrent`, and are
 *  taken off here so none of them reaches the response. */
function toRsvpRecord(row: RsvpRow): RsvpRecord {
  const { dietaryConsentVersion, consentSource, plusOneOf, ...rest } = row;
  return {
    ...rest,
    dietaryPresets: parsePresets(row.dietaryPresets),
    dietaryConsentCurrent: isDietaryConsentCurrent({
      version: dietaryConsentVersion,
      source: consentSource,
      isPlusOne: plusOneOf !== null,
    }),
  };
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
      dietaryPresets: rsvps.dietaryPresets,
      dietaryConsentVersion: rsvps.dietaryConsentVersion,
      consentSource: rsvps.consentSource,
      plusOneOf: guests.plusOneOfGuestId,
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
        const writer = writerOf(input.consentSource ?? "guest");
        yield* Effect.sync(() => metricRsvpUpserted(input.status, writer, "ok"));
      }
    }).pipe(Effect.withSpan("cire.rsvp.submit"));
  },

  /**
   * An organiser's status-only reply: write `status` and leave the stored
   * dietary answer and its consent record as they are, whoever gave them. Same
   * precondition as {@link submitRsvps} — the caller has checked the guest and
   * the invitation.
   *
   * One upsert. With no prior reply it inserts an organiser-attested row
   * holding no dietary data. Over a prior reply it sets the status, and keeps
   * `consent_source` while the row holds any dietary data or consent record
   * (that column is then the data's consent basis, given by whoever wrote it);
   * a row holding none is repointed to `organiser_attested`, the writer of
   * what it now holds. The dietary and consent columns are never written.
   * Returns the row as stored.
   */
  recordStatus(input: {
    guestId: string;
    eventId: string;
    status: RsvpInput["status"];
  }): Effect.Effect<
    {
      status: RsvpInput["status"];
      dietary: string;
      dietaryPresets: DietaryPreset[];
      consentSource: ConsentSource;
    },
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .insert(rsvps)
          .values({
            id: crypto.randomUUID(),
            guestId: input.guestId,
            eventId: input.eventId,
            status: input.status,
            dietary: "",
            dietaryPresets: "",
            dietaryConsentAt: null,
            dietaryConsentVersion: null,
            consentSource: "organiser_attested",
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [rsvps.guestId, rsvps.eventId],
            set: {
              status: input.status,
              consentSource: sql`CASE WHEN ${rsvps.dietary} <> '' OR ${rsvps.dietaryPresets} <> '' OR ${rsvps.dietaryConsentVersion} IS NOT NULL THEN ${rsvps.consentSource} ELSE 'organiser_attested' END`,
            },
          })
          .returning({
            status: rsvps.status,
            dietary: rsvps.dietary,
            dietaryPresets: rsvps.dietaryPresets,
            consentSource: rsvps.consentSource,
          })
          .all(),
      );
      const row = rows[0];
      if (!row) return yield* Effect.die(new Error("rsvp upsert returned no row"));
      // The organiser wrote it, whatever the row's consent basis stays.
      yield* Effect.sync(() => metricRsvpUpserted(input.status, "organiser", "ok"));
      return {
        status: row.status,
        dietary: row.dietary,
        dietaryPresets: parsePresets(row.dietaryPresets),
        consentSource: row.consentSource,
      };
    }).pipe(Effect.withSpan("cire.rsvp.recordStatus"));
  },

  getRsvpsForFamily(familyId: string): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const rows = yield* dbQuery(() => buildFamilyRsvpsQuery(db, familyId).all());

      return rows.map(toRsvpRecord);
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
   *
   * `changeLog`, when given, writes the household's RSVP changes as one
   * statement after the upserts and before the read-back, stamped with the
   * same `now`. Up to 49 pairs that is the replies' own batch; past that the
   * upserts fill earlier batches and the change row rides the last, so a
   * failure there loses the log entry, never invents one for a reply that did
   * not land.
   */
  submitRsvpsAndList(
    inputs: readonly RsvpInput[],
    familyId: string,
    changeLog?: { weddingId: string; changes: readonly RsvpChangeInput[] },
  ): Effect.Effect<RsvpRecord[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;

      const now = new Date();
      const groups = buildRsvpUpsertStatements(db, inputs, now).map((s) => [s]);
      const record = changeLog ? buildRecordStatement(db, { ...changeLog, familyId }, now) : null;
      if (record) groups.push([record]);
      const tail = buildFamilyRsvpsQuery(db, familyId) as ReturningTail<RsvpRow>;

      const rows = yield* dbQuery(() => commitGroupedBatchesReturning<RsvpRow>(db, groups, tail));

      for (const input of inputs) {
        const writer = writerOf(input.consentSource ?? "guest");
        yield* Effect.sync(() => metricRsvpUpserted(input.status, writer, "ok"));
      }

      return rows.map(toRsvpRecord);
    }).pipe(Effect.withSpan("cire.rsvp.submitAndList"));
  },
};
