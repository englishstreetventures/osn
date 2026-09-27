/**
 * The RSVP change log: what guests changed, and how far each organiser has read.
 *
 * `POST /api/rsvp` records one row per guest×event pair whose reply is new or
 * differs from the stored one, in the same batch as the reply (see
 * {@link buildRecordStatement}). The organiser portal reads the rows past the
 * caller's own marker for its "since your last visit" card and the RSVP
 * table's "New" badges; the daily digest (`services/rsvp-digest.ts`) reads them
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
import { and, desc, eq, getTableColumns, gt, lt, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import type { Db } from "../db";
import { DbService, dbQuery } from "../db";
import { metricRsvpChangeSwept } from "../metrics";

/** Change rows older than this are deleted by the daily cron. */
export const RSVP_CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The most unseen rows one feed read returns. Past it the feed says `truncated`. */
export const UNSEEN_ROW_LIMIT = 500;

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
 * A plus-one write records a {@link PlusOneChangeKind} through this in its own
 * batch, with `eventId: null` and the guest who brought the plus-one. The guest
 * plus-one writes are wired in englishstventures/osn#1258.
 */
export function buildRecordStatement(
  db: Db,
  input: { weddingId: string; familyId: string; changes: readonly RsvpChangeInput[] },
  now: Date,
): BatchItem<"sqlite"> | null {
  if (input.changes.length === 0) return null;
  const createdAt = rsvpChanges.createdAt.mapToDriverValue(now);
  const payload = JSON.stringify(
    input.changes.map((change) => [
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
    .select(sql`SELECT ${sql.join(selectList, sql`, `)} FROM json_each(${payload})`);
}

/** One unseen row, as the feed read returns it. */
export interface UnseenRow {
  seq: number;
  familyId: string;
  familyName: string;
  guestId: string;
  eventId: string | null;
  kind: RsvpChangeKind;
  createdAt: Date;
}

/**
 * The caller's unseen rows, newest first, one past the limit so a full read
 * can say it was cut short. The marker is read in a subquery so this runs
 * alongside the caller's settings read rather than after it. Served by
 * `rsvp_changes_wedding_idx` with a rowid range (pinned by a plan test).
 */
export function buildUnseenQuery(db: Db, weddingId: string, osnProfileId: string) {
  const seenSeq = sql`coalesce((SELECT ${hostRsvpNotices.seenSeq} FROM ${hostRsvpNotices} WHERE ${hostRsvpNotices.weddingId} = ${weddingId} AND ${hostRsvpNotices.osnProfileId} = ${osnProfileId}), 0)`;
  return db
    .select({
      seq: rsvpChanges.seq,
      familyId: rsvpChanges.familyId,
      familyName: families.familyName,
      guestId: rsvpChanges.guestId,
      eventId: rsvpChanges.eventId,
      kind: rsvpChanges.kind,
      createdAt: rsvpChanges.createdAt,
    })
    .from(rsvpChanges)
    .innerJoin(families, eq(families.id, rsvpChanges.familyId))
    .where(and(eq(rsvpChanges.weddingId, weddingId), gt(rsvpChanges.seq, seenSeq)))
    .orderBy(desc(rsvpChanges.seq))
    .limit(UNSEEN_ROW_LIMIT + 1);
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
  /** The newest unseen seq — what the portal sends back to mark it all seen. 0 when none. */
  markSeq: number;
  /** Households with an unseen change, among the rows read. */
  households: number;
  /** The read hit its limit, so `households` and `rows` may be short. */
  truncated: boolean;
  items: UnseenHousehold[];
  /** Distinct changed rows for the RSVP table; `eventId: null` means every row of that guest. */
  rows: { guestId: string; eventId: string | null }[];
}

/**
 * Fold rows (newest first) into the feed's shape. `rowLimit` is the limit the
 * read ran with; a read that returned more than it was cut short.
 */
export function summariseUnseen(
  rowsNewestFirst: readonly UnseenRow[],
  itemLimit: number,
  rowLimit: number,
): UnseenSummary {
  const truncated = rowsNewestFirst.length > rowLimit;
  const rows = truncated ? rowsNewestFirst.slice(0, rowLimit) : rowsNewestFirst;

  const households = new Map<
    string,
    { familyName: string; kinds: Set<RsvpChangeKind>; at: Date }
  >();
  const pairs = new Map<string, { guestId: string; eventId: string | null }>();
  for (const row of rows) {
    const household = households.get(row.familyId);
    if (household) household.kinds.add(row.kind);
    else
      households.set(row.familyId, {
        familyName: row.familyName,
        kinds: new Set([row.kind]),
        at: row.createdAt,
      });
    const key = `${row.guestId}::${row.eventId ?? ""}`;
    if (!pairs.has(key)) pairs.set(key, { guestId: row.guestId, eventId: row.eventId });
  }

  const items = [...households.entries()].slice(0, itemLimit).map(([familyId, h]) => ({
    familyId,
    familyName: h.familyName,
    kinds: RSVP_CHANGE_KINDS.filter((kind) => h.kinds.has(kind)),
    at: h.at,
  }));

  return {
    markSeq: rows[0]?.seq ?? 0,
    households: households.size,
    truncated,
    items,
    rows: [...pairs.values()],
  };
}

export interface RsvpChangeFeed extends UnseenSummary {
  digestEnabled: boolean;
}

/** `(select coalesce(max(seq), 0) …)` for one wedding — the newest change's number. */
const newestSeq = (weddingId: string): SQL =>
  sql`(SELECT coalesce(max(${rsvpChanges.seq}), 0) FROM ${rsvpChanges} WHERE ${rsvpChanges.weddingId} = ${weddingId})`;

export const rsvpChangeService = {
  /** The caller's unseen changes and their digest setting. */
  feed(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<RsvpChangeFeed, RsvpChangeError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [settings, rows] = yield* Effect.all(
        [
          dbQuery(() =>
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
          dbQuery(() => buildUnseenQuery(db, weddingId, osnProfileId).all()),
        ],
        { concurrency: "unbounded" },
      );
      return {
        ...summariseUnseen(rows, FEED_ITEM_LIMIT, UNSEEN_ROW_LIMIT),
        digestEnabled: settings[0]?.digestEnabled ?? true,
      };
    }).pipe(Effect.withSpan("cire.rsvp_changes.feed"));
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
