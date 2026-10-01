/**
 * The RSVP change log: what guests changed, and how far each organiser has read.
 *
 * `POST /api/rsvp` records one row per guest×event pair whose reply is new or
 * differs from the stored one, in the same batch as the reply (see
 * {@link buildRecordStatement}); the guest plus-one writes record theirs the
 * same way. The organiser portal reads the rows past the caller's own marker
 * for its "since your last visit" card and, separately, the RSVP table's
 * "New" badges; the daily digest (`services/rsvp-digest.ts`) reads them
 * past each recipient's digest marker. A daily cron deletes rows older than
 * {@link RSVP_CHANGE_RETENTION_MS}.
 *
 * A row carries ids, a kind and a time. The dietary content a reply holds is
 * compared here and never stored in the log.
 */

import {
  families,
  hostRsvpNotices,
  RSVP_CHANGE_KINDS,
  rsvpChanges,
  type RsvpChangeKind,
} from "@cire/db";
import { serialisePresets, type DietaryPreset } from "@cire/dietary";
import { rowsChanged } from "@shared/db-utils";
import { and, asc, desc, eq, getTableColumns, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { metricRsvpChangeSwept } from "../metrics";

/** Change rows older than this are deleted by the daily cron. */
export const RSVP_CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The most change rows one feed read takes. Past it the card's count is a floor. */
export const UNSEEN_SCAN_LIMIT = 5000;

/** The most guest×event pairs the RSVP table badges in one visit. */
export const UNSEEN_PAIR_LIMIT = 500;

/** How many households the feed lists by name. */
export const FEED_ITEM_LIMIT = 5;

export class RsvpChangeError extends Data.TaggedError("RsvpChangeError")<{
  op: "feed" | "seen" | "digest" | "sweep";
  reason: string;
}> {}

/** One change to record. `eventId` is null for the plus-one kinds. */
export interface RsvpChangeInput {
  guestId: string;
  eventId: string | null;
  kind: RsvpChangeKind;
}

/** The kinds a plus-one write records, always with `eventId: null`. */
export type PlusOneChangeKind = Extract<RsvpChangeKind, `plus_one_${string}`>;

/** A stored reply as the comparison needs it: presets as the column holds them. */
export interface PriorReply {
  status: string;
  dietary: string;
  dietaryPresets: string;
}

/** An incoming reply, after the route has normalised it. */
export interface IncomingReply {
  guestId: string;
  eventId: string;
  status: string;
  dietary: string;
  dietaryPresets: readonly DietaryPreset[];
}

export const pairKey = (guestId: string, eventId: string): string => `${guestId}::${eventId}`;

/**
 * Which replies are changes, and of what kind.
 *
 * A pair with no stored reply is `reply_new`; one whose status, dietary text or
 * dietary picks differ is `reply_edited`; an identical re-submit is nothing.
 * Picks are compared in their stored, canonical form, so the order a client
 * sends them in never reads as an edit. A pair named twice in one body is
 * judged once, from its last entry, which is the one the upsert keeps.
 */
export function classifyRsvpChanges(
  prior: ReadonlyMap<string, PriorReply>,
  replies: readonly IncomingReply[],
): RsvpChangeInput[] {
  const lastByPair = new Map<string, IncomingReply>();
  for (const reply of replies) {
    const key = pairKey(reply.guestId, reply.eventId);
    // Delete first so the pair takes the position of its LAST entry.
    lastByPair.delete(key);
    lastByPair.set(key, reply);
  }

  const changes: RsvpChangeInput[] = [];
  for (const [key, reply] of lastByPair) {
    const before = prior.get(key);
    if (!before) {
      changes.push({ guestId: reply.guestId, eventId: reply.eventId, kind: "reply_new" });
      continue;
    }
    const edited =
      before.status !== reply.status ||
      before.dietary !== reply.dietary ||
      before.dietaryPresets !== serialisePresets(reply.dietaryPresets);
    if (edited) {
      changes.push({ guestId: reply.guestId, eventId: reply.eventId, kind: "reply_edited" });
    }
  }
  return changes;
}

/** The column each position of a change's JSON tuple fills. */
const TUPLE_FIELDS = ["weddingId", "familyId", "guestId", "eventId", "kind", "createdAt"] as const;

/**
 * One `INSERT … SELECT … FROM json_each(?)` for the whole change set, or `null`
 * when there is nothing to record.
 *
 * The rows ride as ONE bound JSON parameter, so a 200-pair RSVP stays one
 * statement under D1's 100-parameter cap. It is an insert builder rather than
 * `db.run(sql)` because a builder runs when the batch runs, on both drivers;
 * `db.run` on bun:sqlite runs the moment it is called. Drizzle inserts every
 * column in schema order, so the select list is derived from that order, with
 * `NULL` for `seq` so SQLite assigns the next number.
 *
 * The guest plus-one writes (`services/plus-one.ts`) record a
 * {@link PlusOneChangeKind} through this in their own batch, with
 * `eventId: null` and the guest who brought the plus-one. They pass `when`, a
 * condition the insert's SELECT must meet, so the row is written only when the
 * write it describes happens: it is evaluated inside the batch, against what
 * the statements before it wrote.
 */
export function buildRecordStatement(
  db: Db,
  input: { weddingId: string; familyId: string; changes: readonly RsvpChangeInput[] },
  now: Date,
  when?: SQL,
): BatchItem<"sqlite"> | null {
  const { changes } = input;
  if (changes.length === 0) return null;
  const createdAt = rsvpChanges.createdAt.mapToDriverValue(now);
  const payload = JSON.stringify(
    changes.map((change) => [
      input.weddingId,
      input.familyId,
      change.guestId,
      change.eventId,
      change.kind,
      createdAt,
    ]),
  );
  const selectList = Object.keys(getTableColumns(rsvpChanges)).map((key): SQL => {
    if (key === "seq") return sql`NULL`;
    const position = (TUPLE_FIELDS as readonly string[]).indexOf(key);
    if (position < 0) throw new Error(`rsvp_changes column "${key}" has no tuple position`);
    return sql`json_extract(value, ${`$[${position}]`})`;
  });
  return db
    .insert(rsvpChanges)
    .select(
      when
        ? sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload}) WHERE ${when}`
        : sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload})`,
    );
}

/**
 * The caller's read marker, as a scalar subquery, so a read needs no separate
 * round trip for it. No notice row reads as 0: nothing seen.
 */
const seenMarker = (weddingId: string, osnProfileId: string): SQL =>
  sql`coalesce((SELECT ${hostRsvpNotices.seenSeq} FROM ${hostRsvpNotices} WHERE ${hostRsvpNotices.weddingId} = ${weddingId} AND ${hostRsvpNotices.osnProfileId} = ${osnProfileId}), 0)`;

/**
 * The caller's unseen rows in one wedding. Each feed read takes
 * `UNSEEN_SCAN_LIMIT + 1` of them from one end of the range, as a CTE named
 * `w` carrying only the columns that read uses (the card's is materialised and
 * scanned more than once). Served by `rsvp_changes_wedding_idx` with a rowid
 * range in either direction (pinned by a plan test), so each read costs at most
 * that many rows however long the unseen range is.
 */
const unseenIn = (weddingId: string, osnProfileId: string): SQL | undefined =>
  and(
    eq(rsvpChanges.weddingId, weddingId),
    gt(rsvpChanges.seq, seenMarker(weddingId, osnProfileId)),
  );

/** One row of {@link buildUnseenHouseholdsQuery}: a (household, kind) group. */
export interface UnseenHouseholdRow {
  familyId: string;
  familyName: string;
  kind: RsvpChangeKind;
  /** The group's newest seq. */
  last: number;
  /** The group's newest `created_at`, as stored (epoch seconds). */
  at: number;
  /** Distinct households in the whole window. */
  households: number;
  /** Rows in the window: past {@link UNSEEN_SCAN_LIMIT}, the count is a floor. */
  scanned: number;
}

/**
 * The card's read: the newest `UNSEEN_SCAN_LIMIT + 1` unseen rows, folded in
 * SQL to one row per (household, kind) for the {@link FEED_ITEM_LIMIT}
 * households with the newest change, each row carrying the window's household
 * and row counts. At most five kinds for five households reach the Worker. The
 * household names are joined after the fold, outside the window.
 */
export function buildUnseenHouseholdsQuery(db: Db, weddingId: string, osnProfileId: string) {
  const w = db.$with("w").as(
    db
      .select({
        seq: rsvpChanges.seq,
        familyId: rsvpChanges.familyId,
        kind: rsvpChanges.kind,
        createdAt: rsvpChanges.createdAt,
      })
      .from(rsvpChanges)
      .where(unseenIn(weddingId, osnProfileId))
      .orderBy(desc(rsvpChanges.seq))
      .limit(UNSEEN_SCAN_LIMIT + 1),
  );
  const newestFamilies = db
    .select({ familyId: w.familyId })
    .from(w)
    .groupBy(w.familyId)
    .orderBy(sql`max(${w.seq}) DESC`)
    .limit(FEED_ITEM_LIMIT);
  return db
    .with(w)
    .select({
      familyId: w.familyId,
      familyName: families.familyName,
      kind: w.kind,
      last: sql<number>`max(${w.seq})`.as("last"),
      at: sql<number>`max(${w.createdAt})`.as("at"),
      households: sql<number>`(SELECT count(DISTINCT "family_id") FROM "w")`.as("households"),
      scanned: sql<number>`(SELECT count(*) FROM "w")`.as("scanned"),
    })
    .from(w)
    .innerJoin(families, eq(families.id, w.familyId))
    .where(inArray(w.familyId, newestFamilies))
    .groupBy(w.familyId, w.kind);
}

/** One row of {@link buildUnseenPairsQuery}: a changed guest×event pair. */
export interface UnseenPairRow {
  guestId: string;
  eventId: string | null;
  /** The pair's oldest unseen seq in the window. */
  first: number;
  /** Its newest. */
  last: number;
}

/**
 * The RSVP table's read: the OLDEST `UNSEEN_SCAN_LIMIT + 1` unseen rows,
 * grouped by guest×event, in the order each pair first changed, one pair past
 * {@link UNSEEN_PAIR_LIMIT}. Oldest first is what lets the table mark seen only
 * what it badged (see {@link summarisePairs}).
 */
export function buildUnseenPairsQuery(db: Db, weddingId: string, osnProfileId: string) {
  const w = db.$with("w").as(
    db
      .select({ seq: rsvpChanges.seq, guestId: rsvpChanges.guestId, eventId: rsvpChanges.eventId })
      .from(rsvpChanges)
      .where(unseenIn(weddingId, osnProfileId))
      .orderBy(asc(rsvpChanges.seq))
      .limit(UNSEEN_SCAN_LIMIT + 1),
  );
  return db
    .with(w)
    .select({
      guestId: w.guestId,
      eventId: w.eventId,
      first: sql<number>`min(${w.seq})`.as("first"),
      last: sql<number>`max(${w.seq})`.as("last"),
    })
    .from(w)
    .groupBy(w.guestId, w.eventId)
    .orderBy(sql`min(${w.seq})`)
    .limit(UNSEEN_PAIR_LIMIT + 1);
}

/** A household's unseen changes, folded for the feed card. */
export interface UnseenHousehold {
  familyId: string;
  familyName: string;
  /** In {@link RSVP_CHANGE_KINDS} order. */
  kinds: RsvpChangeKind[];
  /** Its newest change. */
  at: Date;
}

export interface UnseenSummary {
  /** Households with an unseen change, among the rows read. */
  households: number;
  /** More rows are unseen than one read takes, so `households` is a floor. */
  truncated: boolean;
  /** The households with the newest change, newest first. */
  items: UnseenHousehold[];
}

/** Fold the card's rows (see {@link buildUnseenHouseholdsQuery}). */
export function summariseHouseholds(rows: readonly UnseenHouseholdRow[]): UnseenSummary {
  const byFamily = new Map<
    string,
    { familyName: string; kinds: Set<RsvpChangeKind>; last: number; at: number }
  >();
  for (const row of rows) {
    const family = byFamily.get(row.familyId);
    if (!family) {
      byFamily.set(row.familyId, {
        familyName: row.familyName,
        kinds: new Set([row.kind]),
        last: row.last,
        at: row.at,
      });
      continue;
    }
    family.kinds.add(row.kind);
    family.last = Math.max(family.last, row.last);
    family.at = Math.max(family.at, row.at);
  }
  const items = [...byFamily.entries()]
    .toSorted(([, a], [, b]) => b.last - a.last)
    .map(([familyId, f]) => ({
      familyId,
      familyName: f.familyName,
      kinds: RSVP_CHANGE_KINDS.filter((kind) => f.kinds.has(kind)),
      // `created_at` is `integer({ mode: "timestamp" })`: epoch seconds.
      at: new Date(f.at * 1000),
    }));
  const [first] = rows;
  return {
    households: first?.households ?? 0,
    truncated: (first?.scanned ?? 0) > UNSEEN_SCAN_LIMIT,
    items,
  };
}

export interface UnseenRows {
  /**
   * What the table sends back to mark seen: every unseen change at or below it
   * sits in one of `rows`. 0 when nothing is unseen.
   */
  markSeq: number;
  /** Changed rows to badge; `eventId: null` means every row of that guest. */
  rows: { guestId: string; eventId: string | null }[];
}

/**
 * Fold the table's pairs (see {@link buildUnseenPairsQuery}), oldest first.
 *
 * With more pairs than `pairLimit`, the marker stops just below the first
 * pair left out: a change at or below it has a seq below that pair's first,
 * so its own pair first changed earlier and is one of those shown. Otherwise
 * every row the read took is in a shown pair, and the marker is the newest of
 * them; any row past the read's window is newer still. Either way the marker
 * is past the old one whenever anything is unseen, and nothing is marked seen
 * that the table did not badge.
 */
export function summarisePairs(pairs: readonly UnseenPairRow[], pairLimit: number): UnseenRows {
  const shown = pairs.slice(0, pairLimit);
  const next = pairs[pairLimit];
  const markSeq = next
    ? next.first - 1
    : shown.reduce((newest, pair) => Math.max(newest, pair.last), 0);
  return { markSeq, rows: shown.map(({ guestId, eventId }) => ({ guestId, eventId })) };
}

export interface RsvpChangeFeed extends UnseenSummary {
  digestEnabled: boolean;
}

/** `(select coalesce(max(seq), 0) …)` for one wedding — the newest change's number. */
const newestSeq = (weddingId: string): SQL =>
  sql`(SELECT coalesce(max(${rsvpChanges.seq}), 0) FROM ${rsvpChanges} WHERE ${rsvpChanges.weddingId} = ${weddingId})`;

/** A feed read, failing as {@link RsvpChangeError} rather than as a defect. */
const read = <A>(run: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (e) => new RsvpChangeError({ op: "feed", reason: String(e) }),
  });

export const rsvpChangeService = {
  /** The card's summary of the caller's unseen changes, and their digest setting. */
  feed(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<RsvpChangeFeed, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [settings, rows] = yield* Effect.all(
        [
          read(() =>
            db
              .select({ digestEnabled: hostRsvpNotices.digestEnabled })
              .from(hostRsvpNotices)
              .where(
                and(
                  eq(hostRsvpNotices.weddingId, weddingId),
                  eq(hostRsvpNotices.osnProfileId, osnProfileId),
                ),
              )
              .all(),
          ),
          read(() => buildUnseenHouseholdsQuery(db, weddingId, osnProfileId).all()),
        ],
        { concurrency: "unbounded" },
      );
      return {
        ...summariseHouseholds(rows),
        digestEnabled: settings[0]?.digestEnabled ?? true,
      };
    }).pipe(Effect.withSpan("cire.rsvp_changes.feed"));
  },

  /** The RSVP table's changed rows, and the marker that covers exactly them. */
  unseenRows(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<UnseenRows, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const pairs = yield* read(() => buildUnseenPairsQuery(db, weddingId, osnProfileId).all());
      return summarisePairs(pairs, UNSEEN_PAIR_LIMIT);
    }).pipe(Effect.withSpan("cire.rsvp_changes.unseenRows"));
  },

  /**
   * Move the caller's marker to `seq`, clamped to the wedding's newest change
   * and never backwards, so a bad value cannot hide changes that have not
   * happened yet. Returns the stored marker.
   */
  markSeen(
    weddingId: string,
    osnProfileId: string,
    seq: number,
    now: Date = new Date(),
  ): Effect.Effect<number, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(hostRsvpNotices)
              .values({
                weddingId,
                osnProfileId,
                seenSeq: sql`min(${seq}, ${newestSeq(weddingId)})`,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [hostRsvpNotices.weddingId, hostRsvpNotices.osnProfileId],
                set: {
                  seenSeq: sql`max(${hostRsvpNotices.seenSeq}, excluded.seen_seq)`,
                  updatedAt: now,
                },
              })
              .returning({ seenSeq: hostRsvpNotices.seenSeq })
              .all(),
          ),
        catch: (e) => new RsvpChangeError({ op: "seen", reason: String(e) }),
      });
      return rows[0]?.seenSeq ?? 0;
    }).pipe(Effect.withSpan("cire.rsvp_changes.markSeen"));
  },

  /**
   * Turn the caller's digest on or off for this wedding. Turning it back on
   * moves their digest marker to the newest change, so the next email covers
   * what happens from now, not what happened while it was off. A digest that
   * was already on keeps its marker.
   */
  setDigest(
    weddingId: string,
    osnProfileId: string,
    enabled: boolean,
    now: Date = new Date(),
  ): Effect.Effect<boolean, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .insert(hostRsvpNotices)
              .values({ weddingId, osnProfileId, digestEnabled: enabled, updatedAt: now })
              .onConflictDoUpdate({
                target: [hostRsvpNotices.weddingId, hostRsvpNotices.osnProfileId],
                set: {
                  digestSeq: enabled
                    ? sql`CASE WHEN ${hostRsvpNotices.digestEnabled} = 0 THEN max(${hostRsvpNotices.digestSeq}, ${newestSeq(weddingId)}) ELSE ${hostRsvpNotices.digestSeq} END`
                    : sql`${hostRsvpNotices.digestSeq}`,
                  digestEnabled: enabled,
                  updatedAt: now,
                },
              })
              .run(),
          ),
        catch: (e) => new RsvpChangeError({ op: "digest", reason: String(e) }),
      });
      return enabled;
    }).pipe(Effect.withSpan("cire.rsvp_changes.setDigest"));
  },

  /** Delete change rows past the retention window. Returns rows deleted. */
  sweepExpired(now: Date = new Date()): Effect.Effect<number, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cutoff = new Date(now.getTime() - RSVP_CHANGE_RETENTION_MS);
      const result = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(db.delete(rsvpChanges).where(lt(rsvpChanges.createdAt, cutoff)).run()),
        catch: (e) => new RsvpChangeError({ op: "sweep", reason: String(e) }),
      });
      const deleted = rowsChanged(result);
      yield* Effect.sync(() => metricRsvpChangeSwept("ok", deleted));
      yield* Effect.logInfo("rsvp change sweep complete", { deleted });
      return deleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricRsvpChangeSwept("error"))),
      Effect.withSpan("cire.rsvp_changes.sweepExpired"),
    );
  },
};
