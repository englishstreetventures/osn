import { hostRsvpNotices, weddingHosts, weddingInviteCustomisations, weddings } from "@cire/db";
import { and, asc, eq, getTableColumns, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { commitBatchResults, DbService, dbQuery, driverErrorText } from "../db";
import type { Db } from "../db";
import { weddingIsLive } from "../db/live-wedding";
import type { InviteImageKeys } from "./invite";
import { EXEMPT_OWNER_SEATS, normaliseTier, peopleLimitOf, peopleLimitSql } from "./tiers";
import type { PeopleLimit, Tier } from "./tiers";

/**
 * Every value the `wedding_hosts.role` column may hold, read off the column
 * itself. The app-layer vocabulary below derives from this, so the two cannot
 * drift: widening the column widens {@link WeddingRole}, and every exhaustive
 * switch over it stops compiling until the new role is handled.
 */
export type StoredHostRole = (typeof weddingHosts.$inferSelect)["role"];

/**
 * The role a seat gives its holder on a wedding — every organiser, owners
 * included, holds exactly one seat. `owner` manages the wedding itself (who
 * helps, claim codes, settings, billing, deletion) and every owner holds all of
 * it; `editor` gets full module writes (guests, schedule, invite, import — a
 * partner or hired planner); `viewer` is read-only across the dashboard;
 * `helper` is the day-of run sheet and nothing else.
 *
 * `host` is excluded: it is the legacy pre-roles value and still the column's
 * DDL DEFAULT (unchangeable without a table rebuild), but no reader treats it
 * as a role of its own — {@link normaliseHostRole} folds it into `editor`.
 */
export type WeddingRole = Exclude<StoredHostRole, "host">;

/** A seat below owner: the roles a co-host holds. */
export type HostRole = Exclude<WeddingRole, "owner">;

/**
 * Which stored values a route may WRITE onto a seat — one answer per value the
 * column is declared to hold. Exhaustive over {@link StoredHostRole}, so a
 * value added to the column has to be told whether it can be assigned before
 * this compiles, and the answer it cannot acquire by silence is "yes".
 *
 * `host` is `false` and stays that way: it is the column's DDL default and its
 * pre-roles value, not a role anyone holds, and {@link normaliseHostRole} folds
 * it away before any reader sees it. Every route that writes a role is
 * `weddingOwner()`, and an owner may grant every assignable role.
 */
const ASSIGNABLE_HOST_ROLES = {
  host: false,
  owner: true,
  editor: true,
  viewer: true,
  helper: true,
} as const satisfies Record<StoredHostRole, boolean>;

/**
 * The roles the organiser API may WRITE, derived from the map above rather than
 * written out beside it. `add()` and `setRole()` take this, so the compiler
 * proves no route can assign anything outside it — independently of the runtime
 * bar `HostRoleSchema` puts on the request body.
 */
export type AssignableHostRole = {
  [K in StoredHostRole]: (typeof ASSIGNABLE_HOST_ROLES)[K] extends true ? K : never;
}[StoredHostRole];

/**
 * Each role's privilege rank, lowest first. Exhaustive over {@link WeddingRole}
 * by type — a role added to the column must be ranked here before this
 * compiles, which is what makes {@link LEAST_PRIVILEGE_ROLE} true rather than
 * merely intended.
 */
const ROLE_PRIVILEGE_RANK = {
  helper: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
} satisfies Record<WeddingRole, number>;

/**
 * What an unrecognised stored role degrades to: the narrowest role there is.
 * Derived from {@link ROLE_PRIVILEGE_RANK} rather than written out, so adding a
 * role below the current floor moves the floor with it instead of leaving a
 * stale literal that grants more than the newest role gets.
 */
export const LEAST_PRIVILEGE_ROLE: WeddingRole = (
  Object.keys(ROLE_PRIVILEGE_RANK) as WeddingRole[]
).reduce((lowest, role) =>
  ROLE_PRIVILEGE_RANK[role] < ROLE_PRIVILEGE_RANK[lowest] ? role : lowest,
);

/**
 * How far into the run sheet a seat may see, as stored on
 * `wedding_hosts.run_sheet_scope`. It is a helper's setting and no other role's
 * — `runSheetScopeFor()` in `../middleware/wedding-role` is what decides when it
 * applies.
 */
export type RunSheetScope = (typeof weddingHosts.$inferSelect)["runSheetScope"];

const RUN_SHEET_SCOPES = {
  own: true,
  full: true,
} satisfies Record<RunSheetScope, true>;

/** The narrowest scope — what an unrecognised stored value degrades to, so a
 *  corrupted row shows a helper less rather than more. */
export const LEAST_PRIVILEGE_RUN_SHEET_SCOPE: RunSheetScope = "own";

/** Map a stored scope onto {@link RunSheetScope}, degrading anything the column
 *  is not declared to hold to the narrow value. */
export function normaliseRunSheetScope(scope: string): RunSheetScope {
  if (!Object.hasOwn(RUN_SHEET_SCOPES, scope)) return LEAST_PRIVILEGE_RUN_SHEET_SCOPE;
  switch (scope as RunSheetScope) {
    case "own":
      return "own";
    case "full":
      return "full";
  }
  return LEAST_PRIVILEGE_RUN_SHEET_SCOPE;
}

/** Membership test for {@link StoredHostRole}, keyed rather than listed so a
 *  value added to the column has to be answered for here too. Exported so a
 *  test can enumerate the stored roles without restating them — a restated list
 *  is one that stops matching the column the first time it is widened. */
export const STORED_HOST_ROLES = {
  host: true,
  owner: true,
  editor: true,
  viewer: true,
  helper: true,
} satisfies Record<StoredHostRole, true>;

function isStoredHostRole(role: string): role is StoredHostRole {
  return Object.hasOwn(STORED_HOST_ROLES, role);
}

/** Fold a recognised stored value onto the app-layer role it means. */
function mapStoredRole(role: StoredHostRole): WeddingRole {
  switch (role) {
    case "owner":
      return "owner";
    // Migration 0031 rewrote every legacy `host` row to `editor`; a stray one
    // is what every pre-roles co-host effectively was.
    case "host":
    case "editor":
      return "editor";
    case "viewer":
      return "viewer";
    case "helper":
      return "helper";
  }
  const _exhaustive: never = role;
  return LEAST_PRIVILEGE_ROLE;
}

/**
 * Map a stored role onto the app-layer {@link WeddingRole}. A value the column
 * is not declared to hold — corrupted, or written by something that bypassed
 * the schema — degrades to {@link LEAST_PRIVILEGE_ROLE} so the gate chain never
 * fails open.
 */
export function normaliseHostRole(role: string): WeddingRole {
  if (!isStoredHostRole(role)) return LEAST_PRIVILEGE_ROLE;
  return mapStoredRole(role);
}

/** A seat surfaced to the management panel — owners and co-hosts alike. Never
 *  echoes the account id — only the profile id (which the organiser typed a
 *  handle for) + when it was added. */
export interface WeddingHostRow {
  id: string;
  osnProfileId: string;
  role: WeddingRole;
  createdAt: Date;
  /**
   * Who created this seat. Surfaced (not just stored) because a wedding can
   * have several owners and any of them may seat someone: an owner looking at
   * the list needs to see which seats they did not create themselves, since a
   * seat reads the household claim codes and the guests' dietary answers.
   * Without it, a seat another owner added is indistinguishable from one they
   * added themselves, and they have nothing to react to.
   */
  addedByOsnProfileId: string;
}

/** A seat {@link hostsService.remove} deleted, as it stood. */
export interface RemovedSeat {
  role: WeddingRole;
  addedByOsnProfileId: string;
  createdAt: Date;
}

/** A seat could not be added: the target already holds a seat on this wedding
 *  (owners included), or the wedding already holds
 *  {@link MAX_HOSTS_PER_WEDDING} seats. */
export class HostConflict extends Data.TaggedError("HostConflict")<{
  reason: "already_host" | "host_cap_reached";
}> {}

/** A removal or role change would leave the wedding with no owner. Every
 *  wedding keeps at least one; the refused write changed nothing. */
export class LastOwner extends Data.TaggedError("LastOwner")<{
  weddingId: string;
}> {}

/**
 * A seat could not be added, or another owner moved below owner, because the
 * wedding has no room under its tier's people limit. `peopleLimit` is the count
 * the refused write saw, and names the tier that would have let it through. The
 * refused write changed nothing.
 */
export class PeopleLimitReached extends Data.TaggedError("PeopleLimitReached")<{
  weddingId: string;
  peopleLimit: PeopleLimit;
}> {}

/**
 * How many seats — owners included — one wedding may hold, and the reason there
 * is a number here at all.
 *
 * Every seat can be removed by any owner, which is what makes adding one safe:
 * a seat added by mistake, or by an owner the others disagree with, can always
 * be taken back. That depends on the owners being able to SEE every seat — and
 * {@link LIST_CEILING} truncates the list. A security review found 211 seats
 * added, 200 listed, and **11 live seats no owner could see or name in a
 * DELETE**.
 *
 * So the cap sits well below the read ceiling, which turns "the list shows every
 * seat" from a coincidence into a structural invariant. Owners count towards
 * it because owners are listed too. 50 is far past any real wedding (both sets
 * of parents, siblings, a planner) and far short of 200.
 *
 * The tier's people limit sits below it: `add` seats at most the top tier's
 * limit plus the two exempt owners. The cap is the ceiling behind that, and the
 * first refusal named when a wedding seeded past both is full.
 */
export const MAX_HOSTS_PER_WEDDING = 50;

/**
 * Row ceiling on the seat list. Kept ABOVE {@link MAX_HOSTS_PER_WEDDING} on
 * purpose: it is the defensive bound, not the policy, and the gap is what
 * guarantees a wedding at the cap is still listed whole. Legacy weddings
 * seeded past the cap before it existed still list up to this many.
 */
const LIST_CEILING = 200;

/** A host row could not be written/removed (driver error). */
export class HostWriteError extends Data.TaggedError("HostWriteError")<{
  op: "insert" | "update" | "delete";
  reason: string;
}> {}

/** A role change targeted a profile that holds no seat on the wedding. */
export class HostNotFound extends Data.TaggedError("HostNotFound")<{
  weddingId: string;
}> {}

/**
 * Maps a SQLite UNIQUE-constraint failure on the (wedding_id, osn_profile_id)
 * index to the `already_host` conflict. Exported so the brittle string match is
 * pinned by a direct unit test, independent of the driver's exact wording.
 */
export function hostConflictReason(message: string): HostConflict["reason"] | null {
  if (!message.includes("UNIQUE constraint failed")) return null;
  if (message.includes("wedding_hosts")) return "already_host";
  return null;
}

/**
 * Map a failed seat INSERT to its error. The text is read through
 * {@link driverErrorText}: on D1 a failed single statement reaches the caller
 * wrapped, with the database's reason on its `cause`, and only the full text
 * names the unique index that makes it `already_host`.
 */
export function hostAddFailure(error: unknown): HostConflict | HostWriteError {
  const text = driverErrorText(error) || String(error);
  const reason = hostConflictReason(text);
  return reason ? new HostConflict({ reason }) : new HostWriteError({ op: "insert", reason: text });
}

// The subqueries below are keyed by the bound `weddingId`, never by the row of
// the statement around them. Drizzle writes their columns bare when they sit in
// a select list, and a bare name binds to the subquery's own table first, so
// they read the same in a WHERE and in a select list. Tying one to the outer
// row instead would bind `id` to the wrong table without an error.

/** `weddingId`'s owner seats, counted inside whatever statement embeds it. */
function ownerSeatCount(weddingId: string): SQL<number> {
  return sql<number>`(SELECT count(*) FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId} AND ${weddingHosts.role} = 'owner')`;
}

/** Owner seats, as an aggregate over the `wedding_hosts` rows of the query
 *  that embeds it. */
const OWNER_SEATS = sql<number>`total(${weddingHosts.role} = 'owner')`;

/**
 * The people a wedding's tier limit counts, from its seat and owner counts:
 * every seat below owner — `role` is NOT NULL, so that is seats less owners,
 * an unrecognised or legacy role included — plus every owner beyond the first
 * {@link EXEMPT_OWNER_SEATS}. The one definition of who counts: every guard and
 * every read builds its count with this.
 */
function peopleFrom(seats: SQL, owners: SQL): SQL<number> {
  return sql<number>`((${seats}) - (${owners}) + max(0, (${owners}) - ${EXEMPT_OWNER_SEATS}))`;
}

/**
 * A condition over `weddingId`'s seat and owner counts, read in one pass over
 * its seats inside whatever statement embeds it — for a guard in a WHERE.
 */
function overSeats(weddingId: string, condition: (seats: SQL, owners: SQL) => SQL): SQL {
  return sql`(SELECT ${condition(sql`count(*)`, OWNER_SEATS)} FROM ${weddingHosts} WHERE ${weddingHosts.weddingId} = ${weddingId})`;
}

/** "One more person fits under the wedding's people limit", for a guard built
 *  with {@link overSeats}; the limit is read from the tier in the same
 *  statement. */
const roomForOnePerson = (weddingId: string, seats: SQL, owners: SQL): SQL =>
  sql`${peopleFrom(seats, owners)} < ${peopleLimitSql(weddingId)}`;

/** The wedding's tier, read by primary key inside a statement over another
 *  table. A subquery, not the column, so it reads the same in any select. */
const weddingTierSql = (weddingId: string) =>
  sql<string>`(SELECT ${weddings.tier} FROM ${weddings} WHERE ${weddings.id} = ${weddingId})`;

/**
 * The wedding's tier and counts, as a statement for the tail of a host batch:
 * one pass over its seats. Run after the write in the same batch, it reads the
 * state that write left — or, when the write's guard refused, the state the
 * guard saw, which is what names the refusal.
 */
const seatUsage = (db: Db, weddingId: string) =>
  db
    .select({
      tier: weddingTierSql(weddingId),
      people: peopleFrom(sql`count(*)`, OWNER_SEATS),
      owners: OWNER_SEATS,
      seats: sql<number>`count(*)`,
    })
    .from(weddingHosts)
    .where(eq(weddingHosts.weddingId, weddingId));

interface SeatUsage {
  peopleLimit: PeopleLimit;
  owners: number;
  seats: number;
}

/** A {@link seatUsage} result. A wedding with no row reads as Ivory with no
 *  one on it; every caller has already proved the wedding exists. */
function readSeatUsage(rows: unknown): SeatUsage {
  const [row] = rows as readonly { tier: string; people: number; owners: number; seats: number }[];
  return {
    peopleLimit: peopleLimitOf(normaliseTier(row?.tier), Number(row?.people ?? 0)),
    owners: Number(row?.owners ?? 0),
    seats: Number(row?.seats ?? 0),
  };
}

/** The (wedding, profile) pair that names one seat. */
const seatOf = (weddingId: string, osnProfileId: string) =>
  and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId));

type AuthorizeResult = {
  isOwner: boolean;
  /** True for a seat below owner. */
  isHost: boolean;
  role: WeddingRole | null;
  /** The caller's `wedding_hosts.id`, or `null` for a stranger. Every member,
   *  owners included, holds one; the run-sheet gate needs it to tell the
   *  caller's own assignments from everyone else's. */
  hostId: string | null;
  /** The caller's stored run-sheet visibility. `own` for anyone with no seat —
   *  the narrow value, so a missing row can never widen what is returned. */
  runSheetScope: RunSheetScope;
  /** The wedding's slug, read in the same query as the caller's seat, so a
   *  route that names a download after the wedding does not read the row again. */
  weddingSlug: string;
  /** The wedding's plan tier, from the same row, so a tier gate mounted after
   *  the role gate needs no query of its own. */
  weddingTier: Tier;
  /** The wedding's invite image keys, from the same query. Set only by
   *  `authorizeWithInviteImages()`; every other lookup leaves it out. */
  inviteImages?: InviteImageKeys;
  /** The caller's RSVP-change digest setting, from the same query. Set only by
   *  `authorizeWithRsvpDigest()`; every other lookup leaves it out. */
  rsvpDigestEnabled?: boolean;
};

/** What the wedding row and the caller's seat on it — if any — say. */
function resolveSeat(row: {
  slug: string;
  tier: string;
  seatId: string | null;
  role: string | null;
  runSheetScope: string | null;
}): AuthorizeResult {
  const role = row.role === null ? null : normaliseHostRole(row.role);
  return {
    isOwner: role === "owner",
    isHost: role !== null && role !== "owner",
    role,
    hostId: row.seatId,
    runSheetScope:
      row.runSheetScope === null
        ? LEAST_PRIVILEGE_RUN_SHEET_SCOPE
        : normaliseRunSheetScope(row.runSheetScope),
    weddingSlug: row.slug,
    weddingTier: normaliseTier(row.tier),
  };
}

/** The caller's seat joins the wedding row on (wedding, caller), so the one
 *  query answers both "does the wedding exist" and "what is the caller on it". */
const callerSeat = (osnProfileId: string) =>
  and(eq(weddingHosts.weddingId, weddings.id), eq(weddingHosts.osnProfileId, osnProfileId));

/** The columns every authorize query selects: what {@link resolveSeat} reads. */
const seatColumns = {
  slug: weddings.slug,
  tier: weddings.tier,
  seatId: weddingHosts.id,
  role: weddingHosts.role,
  runSheetScope: weddingHosts.runSheetScope,
};

/**
 * `authorize()`: the wedding row and the caller's seat on it, in one query.
 * The wedding row carries the slug and the tier, so neither costs a query of
 * its own. A soft-deleted wedding matches no row, so every gate answers it as
 * unknown.
 */
function authorizeCaller(
  weddingId: string,
  osnProfileId: string,
): Effect.Effect<AuthorizeResult | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select(seatColumns)
        .from(weddings)
        .leftJoin(weddingHosts, callerSeat(osnProfileId))
        .where(and(eq(weddings.id, weddingId), weddingIsLive))
        .all(),
    );
    return row ? resolveSeat(row) : null;
  }).pipe(Effect.withSpan("cire.host.authorize"));
}

/** A refused host change, logged once with the reason and the wedding. */
const logRefusal = (message: string, weddingId: string, reason: string) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ weddingId, reason }));

export const hostsService = {
  /**
   * Seat `osnProfileId` on `weddingId` with the given role.
   *
   * The route has proven, via `weddingOwner()`, that the caller is an owner,
   * and an owner may grant any assignable role, `owner` included.
   * `addedByOsnProfileId` is the caller, kept for attribution.
   *
   * The limits hold under concurrent adds because the INSERT's own WHERE
   * checks them: the wedding's seats against {@link MAX_HOSTS_PER_WEDDING}, and
   * its people against its tier's limit, read from the tier in the same
   * statement. A refused add inserts nothing, which RETURNING reports as no
   * row. A count-then-insert would let two adds at the same moment both pass.
   * The first two owners are free, so seating the partner of a wedding at its
   * limit still works; a third owner counts like anyone else, and a wedding
   * already over its limit seats no one.
   *
   * One batch, one round trip: the INSERT, then reads of the wedding's counts
   * and of the target's seat, which D1 runs in the same transaction. On
   * success the counts are the new ones; on a refusal they are the state the
   * INSERT's WHERE saw, so they name the reason.
   *
   * Three ways to be refused, named in this order: the target already holds a
   * seat, owners included (`already_host` — never a duplicate seat, and never a
   * silent change of an existing seat's role; the unique index answers it when
   * the WHERE lets the row through, and the seat read when the WHERE refused
   * first); the wedding is at the seat cap (`host_cap_reached`: no tier lifts
   * it); or it has no room under its people limit ({@link PeopleLimitReached}).
   */
  add(input: {
    weddingId: string;
    osnProfileId: string;
    addedByOsnProfileId: string;
    role: AssignableHostRole;
  }): Effect.Effect<
    WeddingHostRow & { peopleLimit: PeopleLimit },
    HostConflict | PeopleLimitReached | HostWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const id = `whost_${crypto.randomUUID()}`;
      const now = new Date();
      // One pass over the wedding's seats. An owner within the first two adds
      // no one to the count, so the partner joins a wedding at its limit — but
      // not one already over it, which adds no one until it is back under.
      // Without that, seating a second owner who then steps down would raise
      // the count by one each time, with no bound short of the seat cap.
      const room = overSeats(input.weddingId, (seats, owners) => {
        const personFits = roomForOnePerson(input.weddingId, seats, owners);
        const peopleRoom =
          input.role === "owner"
            ? sql`((${owners} < ${EXEMPT_OWNER_SEATS} AND ${peopleFrom(seats, owners)} <= ${peopleLimitSql(input.weddingId)}) OR ${personFits})`
            : personFits;
        return sql`${seats} < ${MAX_HOSTS_PER_WEDDING} AND ${peopleRoom}`;
      });

      // The SELECT lists its values in the table's column order, which is the
      // column list drizzle writes for an INSERT … SELECT. Built off the
      // columns themselves, so a column added later without a value here
      // throws rather than shifting every value one place along.
      const values = {
        id: sql`${id}`,
        weddingId: sql`${input.weddingId}`,
        osnProfileId: sql`${input.osnProfileId}`,
        addedByOsnProfileId: sql`${input.addedByOsnProfileId}`,
        role: sql`${input.role}`,
        runSheetScope: sql`${LEAST_PRIVILEGE_RUN_SHEET_SCOPE}`,
        createdAt: sql`${weddingHosts.createdAt.mapToDriverValue(now)}`,
      } satisfies Record<keyof typeof weddingHosts.$inferSelect, SQL>;
      const selectList = Object.keys(getTableColumns(weddingHosts)).map((key) => {
        if (!Object.hasOwn(values, key)) {
          throw new Error(`wedding_hosts column "${key}" has no value`);
        }
        return values[key as keyof typeof values];
      });

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db
              .insert(weddingHosts)
              .select(sql`SELECT ${sql.join(selectList, sql`, `)} WHERE ${room}`)
              .returning({ id: weddingHosts.id }),
            seatUsage(db, input.weddingId),
            db
              .select({ id: weddingHosts.id })
              .from(weddingHosts)
              .where(seatOf(input.weddingId, input.osnProfileId)),
          ]),
        catch: hostAddFailure,
      }).pipe(
        Effect.tapError((err) =>
          err._tag === "HostConflict"
            ? logRefusal("host add refused", input.weddingId, err.reason)
            : Effect.logError("host insert failed", { reason: err.reason }),
        ),
      );
      const inserted = results[0] as readonly { id: string }[];
      const usage = readSeatUsage(results[1]);
      const seated = (results[2] as readonly { id: string }[]).length > 0;

      if (inserted.length === 0) {
        if (seated) {
          yield* logRefusal("host add refused", input.weddingId, "already_host");
          return yield* Effect.fail(new HostConflict({ reason: "already_host" }));
        }
        if (usage.seats >= MAX_HOSTS_PER_WEDDING) {
          yield* logRefusal("host add refused", input.weddingId, "host_cap_reached");
          return yield* Effect.fail(new HostConflict({ reason: "host_cap_reached" }));
        }
        yield* logRefusal("host add refused", input.weddingId, "people_limit_reached");
        return yield* Effect.fail(
          new PeopleLimitReached({ weddingId: input.weddingId, peopleLimit: usage.peopleLimit }),
        );
      }

      return {
        id,
        osnProfileId: input.osnProfileId,
        role: input.role,
        createdAt: now,
        addedByOsnProfileId: input.addedByOsnProfileId,
        peopleLimit: usage.peopleLimit,
      };
    }).pipe(Effect.withSpan("cire.host.add"));
  },

  /**
   * Every seat on a wedding — owners and co-hosts — oldest first, plus the true
   * row count.
   *
   * `total` exists so truncation can never be silent. The list is bounded by
   * {@link LIST_CEILING}; the seat cap keeps a compliant wedding well under
   * it, but a wedding seeded past the cap before it existed can still
   * exceed it, and a caller that cannot tell "50 seats" from "50 of 211 seats"
   * will quietly show an owner an incomplete list of who can read their
   * guests' data.
   *
   * `peopleLimit` comes from the same statement: the people count and the
   * wedding's tier ride along every row as scalar subqueries.
   */
  list(weddingId: string): Effect.Effect<
    {
      hosts: WeddingHostRow[];
      total: number;
      peopleLimit: PeopleLimit;
    },
    never,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            id: weddingHosts.id,
            osnProfileId: weddingHosts.osnProfileId,
            role: weddingHosts.role,
            createdAt: weddingHosts.createdAt,
            addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
            // The windows run before LIMIT, so every row carries the wedding's
            // true seat and people counts, not the number returned, from the
            // rows this read already holds.
            total: sql<number>`count(*) over ()`,
            people: peopleFrom(sql`count(*) over ()`, sql`${OWNER_SEATS} over ()`),
            tier: weddingTierSql(weddingId),
          })
          .from(weddingHosts)
          .where(eq(weddingHosts.weddingId, weddingId))
          .orderBy(asc(weddingHosts.createdAt))
          // Defensive ceiling: a wedding has a handful of seats; this bounds
          // the payload if one ever holds pathologically many.
          .limit(LIST_CEILING)
          .all(),
      );
      const first = rows[0];
      return {
        hosts: rows.map((row) => ({
          id: row.id,
          osnProfileId: row.osnProfileId,
          role: normaliseHostRole(row.role),
          createdAt: row.createdAt,
          addedByOsnProfileId: row.addedByOsnProfileId,
        })),
        // No row means no seat, so the count is 0. Every live wedding holds an
        // owner seat, so the Ivory fallback is never what a gated caller sees.
        total: first?.total ?? 0,
        peopleLimit: peopleLimitOf(normaliseTier(first?.tier), Number(first?.people ?? 0)),
      };
    }).pipe(Effect.withSpan("cire.host.list"));
  },

  /**
   * Change a seat's role, owners' included. Scoped to `(weddingId,
   * osnProfileId)` — the route's `weddingOwner()` proved the caller owns this
   * wedding, so this can't retarget another wedding's seat. Setting the role a
   * seat already has succeeds (idempotent).
   *
   * Both guards ride in the UPDATE's own WHERE, so they hold however many
   * owners act at once. Moving an owner down needs another owner to remain.
   * When `actorOsnProfileId` moves ANOTHER owner below owner with no more than
   * the two exempt owners on the wedding, that adds a person to the people
   * count, so it also needs room under the tier's limit; an owner stepping down
   * from their own seat is always allowed, even past the limit. Every other
   * change leaves the count where it was or lowers it: a promotion to owner
   * moves one person out of the co-hosts and, past the first two owners, one
   * into the owners beyond them. A role change adds no seat, so the seat cap
   * does not apply. A refused change writes nothing.
   *
   * One batch: a read of the seat as it stood, the UPDATE, and a read of the
   * wedding's counts after it. The first gives `previousRole` — what tells a
   * caller an owner was demoted — and the last gives the new `peopleLimit`, or,
   * on a refusal, the state the UPDATE's guards saw, which names the reason.
   *
   * Fails `HostNotFound` when the profile holds no seat, `LastOwner` when the
   * seat is the wedding's only owner (named ahead of the limit), and
   * {@link PeopleLimitReached} when demoting another owner has no room.
   */
  setRole(input: {
    weddingId: string;
    osnProfileId: string;
    role: AssignableHostRole;
    /** The owner making the change. Equal to `osnProfileId` for a step-down. */
    actorOsnProfileId: string;
  }): Effect.Effect<
    WeddingHostRow & { previousRole: WeddingRole; peopleLimit: PeopleLimit },
    HostNotFound | LastOwner | PeopleLimitReached | HostWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const ownStepDown = input.actorOsnProfileId === input.osnProfileId;
      // A seat below owner, or one moving to owner, passes; an owner moving
      // down needs another owner to remain, and — unless they are stepping
      // down themselves — room for the person their move adds. One pass over
      // the wedding's seats.
      const allowed =
        input.role === "owner"
          ? undefined
          : or(
              ne(weddingHosts.role, "owner"),
              overSeats(input.weddingId, (seats, owners) =>
                ownStepDown
                  ? sql`${owners} > 1`
                  : sql`${owners} > 1 AND (${owners} > ${EXEMPT_OWNER_SEATS} OR ${roomForOnePerson(input.weddingId, seats, owners)})`,
              ),
            );

      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            // The seat as it stood before the UPDATE: whether it exists, and
            // the role it held, which is how a caller tells a demotion apart.
            db
              .select({ role: weddingHosts.role })
              .from(weddingHosts)
              .where(seatOf(input.weddingId, input.osnProfileId)),
            db
              .update(weddingHosts)
              .set({ role: input.role })
              .where(and(seatOf(input.weddingId, input.osnProfileId), allowed))
              .returning({
                id: weddingHosts.id,
                createdAt: weddingHosts.createdAt,
                addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
              }),
            seatUsage(db, input.weddingId),
          ]),
        catch: (e) => new HostWriteError({ op: "update", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("host role update failed", { reason: err.reason }),
        ),
      );
      const [seat] = results[0] as readonly { role: string }[];
      const [updated] = results[1] as readonly {
        id: string;
        createdAt: Date;
        addedByOsnProfileId: string;
      }[];
      const usage = readSeatUsage(results[2]);

      if (updated && !seat) {
        // Both statements ran in one batch, so a write with no seat before it
        // cannot happen; failing beats reporting a demotion as no change.
        return yield* Effect.fail(
          new HostWriteError({ op: "update", reason: "seat read missing from the batch" }),
        );
      }
      if (!updated || !seat) {
        if (!seat) return yield* Effect.fail(new HostNotFound({ weddingId: input.weddingId }));
        // The seat is there and the UPDATE matched nothing, so it is an owner
        // moving down: with no other owner it is the last-owner guard, and
        // otherwise the people limit.
        if (usage.owners <= 1) {
          yield* logRefusal("host change refused: last owner", input.weddingId, "last_owner");
          return yield* Effect.fail(new LastOwner({ weddingId: input.weddingId }));
        }
        yield* logRefusal(
          "host change refused: people limit",
          input.weddingId,
          "people_limit_reached",
        );
        return yield* Effect.fail(
          new PeopleLimitReached({ weddingId: input.weddingId, peopleLimit: usage.peopleLimit }),
        );
      }

      return {
        id: updated.id,
        osnProfileId: input.osnProfileId,
        role: input.role,
        createdAt: updated.createdAt,
        addedByOsnProfileId: updated.addedByOsnProfileId,
        previousRole: normaliseHostRole(seat.role),
        peopleLimit: usage.peopleLimit,
      };
    }).pipe(Effect.withSpan("cire.host.setRole"));
  },

  /**
   * Remove a seat — a co-host's, another owner's, or the caller's own. Scoped to
   * `(weddingId, osnProfileId)` so an owner can only remove a seat from their
   * own wedding (the route's `weddingOwner()` proved ownership). Idempotent:
   * removing a profile that holds no seat succeeds.
   *
   * The wedding's last owner is never removed: the seat's DELETE carries the
   * guard in its own WHERE, so two owners removing each other at once leave
   * one of them. Their RSVP read marker and digest setting (`host_rsvp_notices`)
   * go in the same batch, ahead of the seat and under the same guard, so a
   * refused removal keeps both and a batch that fails part-way never leaves a
   * seat without its notice row. A read of the seat closes the batch: still
   * there means the guard refused it, which fails `LastOwner`. On success,
   * `removed` is the seat as it stood — its role, who created it and when — or
   * `null` when there was none. With `withPeopleLimit`, a read of the
   * wedding's counts closes the batch and `peopleLimit` is the count after the
   * removal; without it — leaving, whose caller shows no count — the batch
   * reads nothing more and `peopleLimit` is `null`. A removal never adds
   * anyone, so the people limit has nothing to refuse here.
   */
  remove(input: {
    weddingId: string;
    osnProfileId: string;
    withPeopleLimit?: boolean;
  }): Effect.Effect<
    { removed: RemovedSeat | null; peopleLimit: PeopleLimit | null },
    LastOwner | HostWriteError,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const results = yield* Effect.tryPromise({
        try: () =>
          commitBatchResults(db, [
            db.delete(hostRsvpNotices).where(
              and(
                eq(hostRsvpNotices.weddingId, input.weddingId),
                eq(hostRsvpNotices.osnProfileId, input.osnProfileId),
                notExists(
                  db
                    .select({ one: sql`1` })
                    .from(weddingHosts)
                    .where(
                      and(
                        seatOf(input.weddingId, input.osnProfileId),
                        eq(weddingHosts.role, "owner"),
                        sql`${ownerSeatCount(input.weddingId)} <= 1`,
                      ),
                    ),
                ),
              ),
            ),
            db
              .delete(weddingHosts)
              .where(
                and(
                  seatOf(input.weddingId, input.osnProfileId),
                  or(ne(weddingHosts.role, "owner"), sql`${ownerSeatCount(input.weddingId)} > 1`),
                ),
              )
              .returning({
                role: weddingHosts.role,
                addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
                createdAt: weddingHosts.createdAt,
              }),
            db
              .select({ id: weddingHosts.id })
              .from(weddingHosts)
              .where(seatOf(input.weddingId, input.osnProfileId)),
            ...(input.withPeopleLimit ? [seatUsage(db, input.weddingId)] : []),
          ]),
        catch: (e) => new HostWriteError({ op: "delete", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) => Effect.logError("host delete failed", { reason: err.reason })),
      );
      const remaining = results[2] as readonly { id: string }[];
      if (remaining.length > 0) {
        yield* logRefusal("host change refused: last owner", input.weddingId, "last_owner");
        return yield* Effect.fail(new LastOwner({ weddingId: input.weddingId }));
      }
      const [removed] = results[1] as readonly {
        role: string;
        addedByOsnProfileId: string;
        createdAt: Date;
      }[];
      return {
        removed: removed
          ? {
              role: normaliseHostRole(removed.role),
              addedByOsnProfileId: removed.addedByOsnProfileId,
              createdAt: removed.createdAt,
            }
          : null,
        peopleLimit: input.withPeopleLimit ? readSeatUsage(results[3]).peopleLimit : null,
      };
    }).pipe(Effect.withSpan("cire.host.remove"));
  },

  /**
   * Is `osnProfileId` allowed to reach `weddingId`, and at what level? The
   * answer is their seat's role — every organiser, owners included, holds
   * exactly one seat — plus the wedding's slug and tier, in ONE query: the
   * wedding row LEFT JOINed to the caller's seat. `null` means the wedding
   * doesn't exist or is soft-deleted (caller maps to 404); `role` is `null`
   * when the caller holds no seat.
   */
  authorize(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<AuthorizeResult | null, never, DbService> {
    return authorizeCaller(weddingId, osnProfileId);
  },

  /**
   * `authorize()` plus the wedding's invite image keys, in the same single
   * query: the customisation row is LEFT JOINed on the wedding's primary key,
   * so the gate in front of the organiser image read also tells the handler
   * which object each slot points at. The keys are null when the wedding has
   * no customisation row yet. Only `weddingMember(db, { inviteImages: true })`
   * calls this; every other gate keeps the narrower query.
   */
  authorizeWithInviteImages(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<AuthorizeResult | null, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({
            ...seatColumns,
            heroImageKey: weddingInviteCustomisations.heroImageKey,
            storyImageKey: weddingInviteCustomisations.storyImageKey,
            footerImageKey: weddingInviteCustomisations.footerImageKey,
            heroBlur: weddingInviteCustomisations.heroBlur,
          })
          .from(weddings)
          .leftJoin(weddingHosts, callerSeat(osnProfileId))
          .leftJoin(
            weddingInviteCustomisations,
            eq(weddingInviteCustomisations.weddingId, weddings.id),
          )
          .where(and(eq(weddings.id, weddingId), weddingIsLive))
          .all(),
      );
      if (!row) return null;
      const { heroImageKey, storyImageKey, footerImageKey, heroBlur } = row;
      return {
        ...resolveSeat(row),
        inviteImages: { heroImageKey, storyImageKey, footerImageKey, heroBlur },
      };
    }).pipe(Effect.withSpan("cire.host.authorizeWithInviteImages"));
  },

  /**
   * `authorize()` plus the caller's RSVP-change digest setting, in the same
   * single query: the caller's `host_rsvp_notices` row is LEFT JOINed on its
   * primary key (wedding, caller). No row reads as on, as everywhere else that
   * reads the setting. Only `weddingMember(db, { rsvpDigest: true })` calls
   * this, in front of the RSVP-changes card's read; every other gate keeps the
   * narrower query.
   */
  authorizeWithRsvpDigest(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<AuthorizeResult | null, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select({ ...seatColumns, digestEnabled: hostRsvpNotices.digestEnabled })
          .from(weddings)
          .leftJoin(weddingHosts, callerSeat(osnProfileId))
          .leftJoin(
            hostRsvpNotices,
            and(
              eq(hostRsvpNotices.weddingId, weddings.id),
              eq(hostRsvpNotices.osnProfileId, osnProfileId),
            ),
          )
          .where(and(eq(weddings.id, weddingId), weddingIsLive))
          .all(),
      );
      if (!row) return null;
      return { ...resolveSeat(row), rsvpDigestEnabled: row.digestEnabled ?? true };
    }).pipe(Effect.withSpan("cire.host.authorizeWithRsvpDigest"));
  },

  /**
   * `authorize()` for the one route that must see a soft-deleted wedding: its
   * owners' restore. The same single query without the live-wedding predicate.
   * Whether the wedding is deleted, and for how long, is the restore's own
   * guarded write to decide. No other caller may use it — every other
   * organiser route answers a deleted wedding as unknown.
   */
  authorizeIncludingDeleted(
    weddingId: string,
    osnProfileId: string,
  ): Effect.Effect<AuthorizeResult | null, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db
          .select(seatColumns)
          .from(weddings)
          .leftJoin(weddingHosts, callerSeat(osnProfileId))
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      return row ? resolveSeat(row) : null;
    }).pipe(Effect.withSpan("cire.host.authorizeIncludingDeleted"));
  },
};
